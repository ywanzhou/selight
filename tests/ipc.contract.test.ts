import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../electron/db/schema'
import { createHandlers, type HandlerDeps } from '../electron/ipc'
import type { ExifReader } from '../electron/scanner'
import type { MediaQueue } from '../electron/media/queue'
import type { SelightApi } from '../electron/shared/api'

// This suite is the end-to-end domain chain driven through the pure handler factory.
// It must never import electron: createHandlers takes every dependency (db, queue,
// cache roots, exif reader) up front, so the whole IPC contract runs under bare Node.

const dirs: string[] = []
const handles: Database[] = []

const fakeReader: ExifReader = { readOrientation: async () => 1 }

interface Setup {
  handlers: SelightApi
  db: Database
  queueCalls: { enqueue: number[][]; prioritize: number[][] }
}

function setup(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-ipc-'))
  dirs.push(dir)
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)

  const thumbDir = path.join(dir, 'thumbnails')
  const previewDir = path.join(dir, 'previews')
  fs.mkdirSync(thumbDir)
  fs.mkdirSync(previewDir)

  // Recording stand-in for MediaQueue: structural type matches the enqueue/prioritize
  // surface the handlers depend on, and lets tests assert queue wiring without Electron.
  const queueCalls = { enqueue: [] as number[][], prioritize: [] as number[][] }
  const thumbQueue: Pick<MediaQueue, 'enqueue' | 'prioritize'> = {
    enqueue: (ids) => queueCalls.enqueue.push([...ids]),
    prioritize: (ids) => queueCalls.prioritize.push([...ids])
  }

  const deps: HandlerDeps = { db, thumbQueue, roots: { thumbDir, previewDir }, exifReader: fakeReader }
  return { handlers: createHandlers(deps), db, queueCalls }
}

afterEach(() => {
  while (handles.length) {
    const db = handles.pop()!
    if (db.open) db.close()
  }
  while (dirs.length) {
    const dir = dirs.pop()!
    for (const f of walkFiles(dir)) {
      try {
        fs.chmodSync(f, 0o666)
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

function writeFile(dir: string, name: string, contents = 'x'): string {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
  return p
}

// Four supported photos across nested dirs, one ignored txt, one empty dir.
function makeFixtureTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-ipc-tree-'))
  dirs.push(root)
  writeFile(root, 'a.jpg', 'jpeg-a')
  writeFile(root, 'b.png', 'png-b')
  writeFile(root, 'note.txt', 'not a photo')
  writeFile(root, 'sub/c.webp', 'webp-c')
  writeFile(root, 'sub/nested/d.arw', 'raw-d')
  fs.mkdirSync(path.join(root, 'empty'))
  return root
}

async function expectRejectName(fn: () => Promise<unknown>, name: string): Promise<void> {
  const err = await fn().then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).name).toBe(name)
}

describe('IPC handler contract — full curation chain', () => {
  it('runs batch → folder → import → assign → counts → trash → restore → delete → undo through the handlers', async () => {
    const { handlers, queueCalls } = setup()

    const batch = await handlers.createBatch()
    expect(batch.id).toBeGreaterThan(0)
    expect(await handlers.listBatches()).toHaveLength(1)

    const folder = await handlers.createFolder(batch.id, '精选')
    const root = makeFixtureTree()

    // Import: four supported photos, no failures, and every imported id is queued for thumbs.
    const imported = await handlers.importDirectory(batch.id, root)
    expect(imported).toEqual({ added: 4, updated: 0, missing: 0, failures: [] })
    const inbox = await handlers.listView(batch.id, { kind: 'inbox' })
    expect(inbox).toHaveLength(4)
    expect(inbox.every((p) => p.status === 'inbox')).toBe(true)
    const inboxIds = inbox.map((p) => p.id)
    expect(queueCalls.enqueue).toHaveLength(1)
    expect(new Set(queueCalls.enqueue[0])).toEqual(new Set(inboxIds))

    expect(await handlers.counts(batch.id)).toEqual({
      total: 4,
      inbox: 4,
      folder: 0,
      trash: 0
    })

    // mediaUrl only builds the selight:// URL; authorization stays in the media protocol.
    expect(await handlers.mediaUrl(inboxIds[0], 'thumb')).toBe(`selight://thumb/${inboxIds[0]}`)
    expect(await handlers.mediaUrl(inboxIds[0], 'photo')).toBe(`selight://photo/${inboxIds[0]}`)

    // Assign two photos to the folder; counts move inbox → folder.
    const assigned = await handlers.assign([inboxIds[0], inboxIds[1]], folder.id)
    expect(assigned).toBe(2)
    expect(await handlers.counts(batch.id)).toEqual({
      total: 4,
      inbox: 2,
      folder: 2,
      trash: 0
    })
    const folderView = await handlers.listView(batch.id, {
      kind: 'folder',
      folderId: folder.id
    })
    expect(folderView.map((p) => p.id).sort()).toEqual([inboxIds[0], inboxIds[1]].sort())

    // Trash one, then restore: the live folder means it returns to the folder.
    expect(await handlers.trash([inboxIds[0]])).toBe(1)
    expect((await handlers.counts(batch.id)).trash).toBe(1)
    expect(await handlers.restore([inboxIds[0]])).toBe(1)
    expect(await handlers.counts(batch.id)).toEqual({
      total: 4,
      inbox: 2,
      folder: 2,
      trash: 0
    })

    // Folder deletion goes through deleteFolderWithPhotos (undoable), not a bare soft delete.
    expect(await handlers.deleteFolder(folder.id)).toBe(2)
    expect((await handlers.listFolders(batch.id)).map((f) => f.id)).not.toContain(folder.id)
    expect(await handlers.counts(batch.id)).toEqual({
      total: 4,
      inbox: 4,
      folder: 0,
      trash: 0
    })

    // One undo revives the folder and returns its photos in a single group.
    expect(await handlers.undo(batch.id)).toBe(true)
    const revivedFolders = await handlers.listFolders(batch.id)
    expect(revivedFolders.map((f) => f.id)).toContain(folder.id)
    expect(await handlers.counts(batch.id)).toEqual({
      total: 4,
      inbox: 2,
      folder: 2,
      trash: 0
    })
    const revivedView = await handlers.listView(batch.id, {
      kind: 'folder',
      folderId: folder.id
    })
    expect(revivedView.map((p) => p.id).sort()).toEqual([inboxIds[0], inboxIds[1]].sort())

    // openBatch touches last_opened_at and returns the full first-paint state.
    const state = await handlers.openBatch(batch.id)
    expect(state.batch.id).toBe(batch.id)
    expect(state.batch.lastOpenedAt).toBeGreaterThanOrEqual(batch.lastOpenedAt)
    expect(state.folders.map((f) => f.id)).toContain(folder.id)
    expect(state.counts).toEqual(await handlers.counts(batch.id))
    // Default view on open is inbox: exactly the two inbox photos.
    expect(state.photos.map((p) => p.id).sort()).toEqual(
      (await handlers.listView(batch.id, { kind: 'inbox' })).map((p) => p.id).sort()
    )

    // markSelection forwards the visible ids straight to the queue's prioritize path.
    await handlers.markSelection([42, 43])
    expect(queueCalls.prioritize.at(-1)).toEqual([42, 43])
  })

  it('re-importing the same directory updates rows, reuses the source, and reports no failures', async () => {
    const { handlers, db } = setup()
    const batch = await handlers.createBatch()
    const root = makeFixtureTree()

    expect(await handlers.importDirectory(batch.id, root)).toMatchObject({ added: 4, updated: 0 })
    const second = await handlers.importDirectory(batch.id, root)
    expect(second).toEqual({ added: 0, updated: 4, missing: 0, failures: [] })

    // The (batch_id, abs_path) unique source is reused, not duplicated.
    const sourceCount = (
      db
        .prepare('SELECT COUNT(*) AS n FROM sources WHERE batch_id = ? AND abs_path = ?')
        .get(batch.id, root) as { n: number }
    ).n
    expect(sourceCount).toBe(1)
  })

  it('surfaces unreadable/missing roots in the failures array without throwing', async () => {
    const { handlers } = setup()
    const batch = await handlers.createBatch()
    const missingRoot = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'selight-ipc-missing-')),
      'does-not-exist'
    )

    const result = await handlers.importDirectory(batch.id, missingRoot)
    expect(result.added).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.missing).toBe(0)
    expect(result.failures).toContain(missingRoot)
    expect(await handlers.counts(batch.id)).toEqual({
      total: 0,
      inbox: 0,
      folder: 0,
      trash: 0
    })
  })

  it('propagates domain errors with their .name intact for the renderer to branch on', async () => {
    const { handlers } = setup()
    const batch = await handlers.createBatch()
    await handlers.createFolder(batch.id, 'dup')
    await expectRejectName(() => handlers.createFolder(batch.id, 'dup'), 'FolderNameConflictError')
    await expectRejectName(() => handlers.deleteFolder(999_999), 'FolderNotFoundError')

    // MixedBatchError: photos from two batches cannot share one classification group.
    const batchA = await handlers.createBatch('a')
    const batchB = await handlers.createBatch('b')
    const folderA = await handlers.createFolder(batchA.id, 'fa')
    const root = makeFixtureTree()
    await handlers.importDirectory(batchA.id, root)
    await handlers.importDirectory(batchB.id, root)
    const idA = (await handlers.listView(batchA.id, { kind: 'inbox' }))[0].id
    const idB = (await handlers.listView(batchB.id, { kind: 'inbox' }))[0].id
    await expectRejectName(
      () => handlers.assign([idA, idB], folderA.id),
      'MixedBatchError'
    )
  })

  it('renames a folder and lists it under the new name', async () => {
    const { handlers } = setup()
    const batch = await handlers.createBatch()
    const folder = await handlers.createFolder(batch.id, 'old')
    await handlers.renameFolder(folder.id, 'new')
    const names = (await handlers.listFolders(batch.id)).map((f) => f.name)
    expect(names).toContain('new')
    expect(names).not.toContain('old')
  })

  it('undo returns false when the batch has no undoable group', async () => {
    const { handlers } = setup()
    const batch = await handlers.createBatch()
    expect(await handlers.undo(batch.id)).toBe(false)
  })
})
