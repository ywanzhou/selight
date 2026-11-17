import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { createFolder, listFolders } from '../../electron/domain/folders'
import { counts, listPhotos } from '../../electron/domain/photos'
import { parseSession, serializeSession, type SessionState } from '../../electron/session'
import { createFileSessionStore } from '../../electron/sessionStore'
import { importScanned, scanDirectory } from '../../electron/scanner'

// Session persistence is pure JSON shape logic (parse/serialize) plus a node-only
// file store; neither imports electron, so the whole contract runs under bare Node.

describe('session parse/serialize round trip', () => {
  const cases = [
    { name: 'null batch + inbox', state: { batchId: null, view: { kind: 'inbox' } } },
    { name: 'open batch + inbox', state: { batchId: 7, view: { kind: 'inbox' } } },
    {
      name: 'folder view',
      state: { batchId: 3, view: { kind: 'folder', folderId: 42 } }
    },
    { name: 'trash view', state: { batchId: 3, view: { kind: 'trash' } } }
  ] as const

  it.each(cases)('preserves batchId and view kind: $name', ({ state }) => {
    const parsed = parseSession(serializeSession(structuredClone(state)))
    expect(parsed).toEqual(state)
  })

  it('never throws and returns null for corrupt or non-object JSON', () => {
    const garbage = ['', '{', 'not json', 'null', '42', '"a string"', '[]', 'true']
    for (const text of garbage) {
      expect(() => parseSession(text)).not.toThrow()
      expect(parseSession(text)).toBeNull()
    }
  })

  it('returns null for wrong-typed fields instead of coercing them', () => {
    const bad = [
      '{"batchId":"1","view":{"kind":"inbox"}}',
      '{"batchId":1.5,"view":{"kind":"inbox"}}',
      '{"batchId":true,"view":{"kind":"inbox"}}',
      '{"view":{"kind":"inbox"}}',
      '{"batchId":1,"view":null}',
      '{"batchId":1,"view":"inbox"}',
      '{"batchId":1,"view":{}}',
      '{"batchId":1,"view":{"kind":"bogus"}}',
      '{"batchId":1,"view":{"kind":"folder"}}',
      '{"batchId":1,"view":{"kind":"folder","folderId":"9"}}',
      '{"batchId":1,"view":{"kind":"folder","folderId":1.5}}'
    ]
    for (const text of bad) {
      expect(parseSession(text)).toBeNull()
    }
  })

  it('tolerates unknown extra fields', () => {
    const parsed = parseSession(
      JSON.stringify({ batchId: 1, view: { kind: 'inbox' }, future: 'x' })
    )
    expect(parsed).toEqual({ batchId: 1, view: { kind: 'inbox' } })
  })
})

describe('file session store', () => {
  const dirs: string[] = []
  let dir: string
  let file: string

  beforeEach(() => {
    vi.useFakeTimers()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-session-'))
    dirs.push(dir)
    file = path.join(dir, 'session.json')
  })

  afterEach(() => {
    vi.useRealTimers()
    while (dirs.length) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  })

  it('reads null when no session file exists yet', () => {
    expect(createFileSessionStore(file).read()).toBeNull()
  })

  it('debounces writes and lands the last state atomically without a leftover .tmp', () => {
    const store = createFileSessionStore(file, 250)
    store.write({ batchId: 1, view: { kind: 'inbox' } })
    store.write({ batchId: 2, view: { kind: 'trash' } })

    // Deferred: nothing on disk before the debounce window elapses.
    expect(fs.existsSync(file)).toBe(false)
    vi.advanceTimersByTime(250)

    expect(parseSession(fs.readFileSync(file, 'utf8'))).toEqual({
      batchId: 2,
      view: { kind: 'trash' }
    })
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('flush writes the pending state immediately for quit-time persistence', () => {
    const store = createFileSessionStore(file)
    const state: SessionState = { batchId: 9, view: { kind: 'folder', folderId: 4 } }
    store.write(state)
    store.flush()

    expect(parseSession(fs.readFileSync(file, 'utf8'))).toEqual(state)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)

    // A later flush with nothing pending must not touch the file.
    const mtime = fs.statSync(file).mtimeMs
    store.flush()
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
  })

  it('survives a garbage session file: read returns null instead of throwing', () => {
    fs.writeFileSync(file, '{ broken json')
    const store = createFileSessionStore(file)
    expect(() => store.read()).not.toThrow()
    expect(store.read()).toBeNull()
  })

  it('read after write round trips through the real filesystem', () => {
    const store = createFileSessionStore(file)
    const state: SessionState = { batchId: null, view: { kind: 'inbox' } }
    store.write(state)
    store.flush()
    expect(store.read()).toEqual(state)
  })
})

describe('batch isolation across same relative path imports', () => {
  const dirs: string[] = []
  const handles: Database[] = []

  function tempDb(): Database {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-isolation-'))
    dirs.push(dir)
    const { db } = openDatabase(path.join(dir, 'selight.db'))
    handles.push(db)
    return db
  }

  // Two distinct import roots, each carrying the SAME relative path/filename.
  async function makeRoot(tag: string): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `selight-tree-${tag}-`))
    dirs.push(root)
    const p = path.join(root, 'trip', 'a.jpg')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `jpeg-${tag}`)
    return root
  }

  async function importRoot(db: Database, batchId: number, root: string): Promise<void> {
    const { files } = await scanDirectory(root)
    const info = db
      .prepare('INSERT INTO sources (batch_id, abs_path, last_scan_at) VALUES (?, ?, ?)')
      .run(batchId, root, Date.now())
    importScanned(db, batchId, Number(info.lastInsertRowid), files)
  }

  afterEach(() => {
    while (handles.length) {
      const db = handles.pop()!
      if (db.open) db.close()
    }
    while (dirs.length) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  })

  it('keeps photos, counts and folders strictly separated even for identical relative paths', async () => {
    const db = tempDb()
    const batchA = createBatch(db, 'A')
    const batchB = createBatch(db, 'B')
    const rootA = await makeRoot('a')
    const rootB = await makeRoot('b')
    await importRoot(db, batchA.id, rootA)
    await importRoot(db, batchB.id, rootB)

    const inboxA = listPhotos(db, batchA.id, { kind: 'inbox' })
    const inboxB = listPhotos(db, batchB.id, { kind: 'inbox' })
    expect(inboxA).toHaveLength(1)
    expect(inboxB).toHaveLength(1)
    // Same relative path/filename, different batches: distinct rows, each scoped to its batch.
    expect(inboxA[0].filename).toBe('a.jpg')
    expect(inboxB[0].filename).toBe('a.jpg')
    expect(inboxA[0].id).not.toBe(inboxB[0].id)
    expect(inboxA[0].batchId).toBe(batchA.id)
    expect(inboxB[0].batchId).toBe(batchB.id)
    expect(inboxA.every((p) => p.batchId === batchA.id)).toBe(true)
    expect(inboxB.every((p) => p.batchId === batchB.id)).toBe(true)

    // Neither batch sees the other through trash or folder views.
    expect(listPhotos(db, batchA.id, { kind: 'trash' })).toHaveLength(0)
    expect(listPhotos(db, batchB.id, { kind: 'trash' })).toHaveLength(0)

    expect(counts(db, batchA.id)).toEqual({ total: 1, inbox: 1, folder: 0, trash: 0 })
    expect(counts(db, batchB.id)).toEqual({ total: 1, inbox: 1, folder: 0, trash: 0 })

    const folderA = createFolder(db, batchA.id, '精选')
    const foldersB = listFolders(db, batchB.id)
    expect(foldersB).toHaveLength(0)
    expect(listFolders(db, batchA.id).map((f) => f.id)).toContain(folderA.id)

    // A folder view scoped to batch B cannot surface A's folder or A's photo.
    expect(
      listPhotos(db, batchB.id, { kind: 'folder', folderId: folderA.id })
    ).toHaveLength(0)
  })
})
