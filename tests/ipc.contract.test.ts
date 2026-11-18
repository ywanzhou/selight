import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../electron/db/schema'
import { createHandlers, type HandlerDeps } from '../electron/ipc'
import type { MediaQueue } from '../electron/media/queue'
import type { SessionState, SessionStore } from '../electron/session'
import { IPC_CHANNELS, type SelightApi, type SelightHandlers } from '../electron/shared/api'
import type { Manifest } from '../electron/manifest'

// This suite is the end-to-end domain chain driven through the pure handler factory.
// It must never import electron: createHandlers takes every dependency (db, queue,
// enrichment, cache roots) up front, so the whole IPC contract runs under bare Node.

const dirs: string[] = []
const handles: Database[] = []

interface Setup {
  handlers: SelightHandlers
  db: Database
  queueCalls: { enqueue: number[][]; prioritize: number[][] }
  enrichmentCalls: number[][]
  enrichment: { submit: (ids: number[]) => void; cancel: ReturnType<typeof vi.fn>; stop: () => void }
  retryCalls: { thumb: number[][]; photo: number[][] }
  sessionStore: SessionStore
  mediaRoots: { thumbDir: string; previewDir: string }
}

function setup(): Setup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-ipc-'))
  dirs.push(dir)
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)

  const mediaRoots = {
    thumbDir: path.join(dir, 'thumbnails'),
    previewDir: path.join(dir, 'previews')
  }
  fs.mkdirSync(mediaRoots.thumbDir, { recursive: true })
  fs.mkdirSync(mediaRoots.previewDir, { recursive: true })

  // Recording stand-in for MediaQueue: structural type matches the enqueue/prioritize
  // surface the handlers depend on, and lets tests assert queue wiring without Electron.
  const queueCalls = { enqueue: [] as number[][], prioritize: [] as number[][] }
  const thumbQueue: Pick<MediaQueue, 'enqueue' | 'prioritize'> = {
    enqueue: (ids) => queueCalls.enqueue.push([...ids]),
    prioritize: (ids) => queueCalls.prioritize.push([...ids])
  }

  // Recording stand-in for the EnrichmentService: imports submit freshly
  // discovered ids here instead of touching the thumbnail queue directly.
  const enrichmentCalls: number[][] = []
  const enrichment = {
    submit: (ids: number[]) => enrichmentCalls.push([...ids]),
    cancel: vi.fn(),
    stop: () => undefined
  }

  // Recording retry seam: cache deletion is covered by tests/media/retry.test.ts.
  const retryCalls: { thumb: number[][]; photo: number[][] } = { thumb: [], photo: [] }
  const retry = {
    retryThumb: (id: number) => retryCalls.thumb.push([id]),
    retryPreview: (id: number) => retryCalls.photo.push([id])
  }

  // Fake session storage: the handler stays electron-free; the real file store is
  // covered in tests/domain/session.test.ts.
  const sessionStore: SessionStore = {
    read: vi.fn(() => null),
    write: vi.fn(),
    flush: vi.fn()
  }

  const deps: HandlerDeps = {
    db,
    thumbQueue,
    enrichment,
    retry,
    mediaRoots,
    sessionStore
  }
  return {
    handlers: createHandlers(deps),
    db,
    queueCalls,
    enrichmentCalls,
    enrichment,
    retryCalls,
    sessionStore,
    mediaRoots
  }
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
    const { handlers, queueCalls, enrichmentCalls } = setup()

    const batch = await handlers.createBatch()
    expect(batch.id).toBeGreaterThan(0)
    expect(await handlers.listBatches()).toHaveLength(1)

    const folder = await handlers.createFolder(batch.id, '精选')
    const root = makeFixtureTree()

    // Import: four supported photos, no failures, and every imported id is submitted
    // for background enrichment rather than pushed straight into the thumbnail queue.
    const imported = await handlers.importDirectory(batch.id, root)
    expect(imported).toEqual({ added: 4, updated: 0, missing: 0, failures: [] })
    const inbox = await handlers.listView(batch.id, { kind: 'inbox' })
    expect(inbox).toHaveLength(4)
    expect(inbox.every((p) => p.status === 'inbox')).toBe(true)
    const inboxIds = inbox.map((p) => p.id)
    expect(enrichmentCalls).toHaveLength(1)
    expect(new Set(enrichmentCalls[0])).toEqual(new Set(inboxIds))
    expect(queueCalls.enqueue).toHaveLength(0)

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

  it('submits unenriched rows to the enrichment service when a batch is opened', async () => {
    const { handlers, enrichmentCalls, db } = setup()
    const batch = await handlers.createBatch()
    const root = makeFixtureTree()
    await handlers.importDirectory(batch.id, root)
    enrichmentCalls.length = 0

    // Fresh rows still carry width IS NULL, so openBatch must re-submit them
    // as the restart/interruption catch-up path.
    const state = await handlers.openBatch(batch.id)
    const inboxIds = state.photos.map((p) => p.id).sort((a, b) => a - b)
    expect(enrichmentCalls).toHaveLength(1)
    expect([...enrichmentCalls[0]].sort((a, b) => a - b)).toEqual(inboxIds)

    // After every row is enriched the catch-up submits nothing.
    db.prepare('UPDATE photos SET width = 100, height = 80 WHERE batch_id = ?').run(
      batch.id
    )
    enrichmentCalls.length = 0
    await handlers.openBatch(batch.id)
    expect(enrichmentCalls).toHaveLength(0)
  })

  it('cancelImport during discovery returns an empty result and writes no rows', async () => {
    const { handlers, db, enrichmentCalls } = setup()
    const batch = await handlers.createBatch()
    const root = makeFixtureTree()

    // Do not await: cancel while the fs walk is suspended in its first readdir,
    // so the abort check at the next walk boundary throws AbortError.
    const inFlight = handlers.importDirectory(batch.id, root)
    handlers.cancelImport()
    const result = await inFlight

    expect(result).toEqual({ added: 0, updated: 0, missing: 0, failures: [] })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n
    ).toBe(0)
    // The aborted import never reached the enrichment submission.
    expect(enrichmentCalls).toEqual([])
  })

  it('cancelImport cancels enrichment and remains safe with no active scan', async () => {
    const { handlers, enrichment } = setup()
    await handlers.cancelImport()
    expect(enrichment.cancel).toHaveBeenCalledTimes(1)

    // Re-open still works after a cancel with no scan in flight.
    const batch = await handlers.createBatch()
    const state = await handlers.openBatch(batch.id)
    expect(state.batch.id).toBe(batch.id)
  })

  it('cleanupMediaCache deletes orphan cache files and keeps live artifacts', async () => {
    const { handlers, mediaRoots } = setup()
    const root = makeFixtureTree()
    const imported = await handlers.importDirectory((await handlers.createBatch()).id, root)
    expect(imported.added).toBeGreaterThan(0)

    const liveId = (await handlers.listView((await handlers.listBatches())[0].id, {
      kind: 'inbox'
    }))[0].id
    fs.writeFileSync(path.join(mediaRoots.thumbDir, `${liveId}.jpg`), 'live')
    const orphan = path.join(mediaRoots.thumbDir, '888888.jpg')
    const orphanSidecar = path.join(mediaRoots.previewDir, '888888.jpg.placeholder')
    fs.writeFileSync(orphan, 'orphan')
    fs.writeFileSync(orphanSidecar, '')

    const result = await handlers.cleanupMediaCache()
    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.existsSync(orphanSidecar)).toBe(false)
    expect(fs.existsSync(path.join(mediaRoots.thumbDir, `${liveId}.jpg`))).toBe(true)
    expect(result.removed).toBe(2)
  })

  it('retryMedia dispatches to the matching thumb or preview retry seam', async () => {
    const { handlers, retryCalls } = setup()
    await handlers.retryMedia(7, 'thumb')
    await handlers.retryMedia(9, 'photo')
    expect(retryCalls.thumb).toEqual([[7]])
    expect(retryCalls.photo).toEqual([[9]])
  })

  it('unassign moves folder photos back to inbox through the handler and one undo restores them', async () => {
    const { handlers } = setup()
    const batch = await handlers.createBatch()
    const folder = await handlers.createFolder(batch.id, '精选')
    const root = makeFixtureTree()
    await handlers.importDirectory(batch.id, root)
    const inbox = await handlers.listView(batch.id, { kind: 'inbox' })
    const ids = inbox.slice(0, 2).map((p) => p.id)

    await handlers.assign(ids, folder.id)
    expect(await handlers.unassign(ids)).toBe(2)

    expect(await handlers.counts(batch.id)).toEqual({
      total: 4,
      inbox: 4,
      folder: 0,
      trash: 0
    })
    const backInInbox = await handlers.listView(batch.id, { kind: 'inbox' })
    expect(backInInbox.map((p) => p.id)).toEqual(expect.arrayContaining(ids))

    // The unassign is one action group: a single undo puts both photos back.
    expect(await handlers.undo(batch.id)).toBe(true)
    expect((await handlers.counts(batch.id)).folder).toBe(2)
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

  it('deleteBatch removes every row of the batch and its cache files, leaving other batches intact', async () => {
    const { handlers, mediaRoots } = setup()
    const batch = await handlers.createBatch()
    const keep = await handlers.createBatch('keep')
    const root = makeFixtureTree()
    await handlers.importDirectory(batch.id, root)
    const inbox = await handlers.listView(batch.id, { kind: 'inbox' })
    const victim = inbox[0].id

    fs.writeFileSync(path.join(mediaRoots.thumbDir, `${victim}.jpg`), 'thumb')
    fs.writeFileSync(path.join(mediaRoots.thumbDir, `${victim}.jpg.placeholder`), 'marker')
    fs.writeFileSync(path.join(mediaRoots.previewDir, `${victim}.jpg`), 'preview')
    // Cache belonging to another batch (different photo id) must survive.
    const keepCache = path.join(mediaRoots.thumbDir, '999999.jpg')
    fs.writeFileSync(keepCache, 'keep')

    expect(await handlers.deleteBatch(batch.id)).toBe(4)

    const remaining = await handlers.listBatches()
    expect(remaining.map((b) => b.id)).toEqual([keep.id])
    expect(await handlers.listView(batch.id, { kind: 'inbox' })).toEqual([])
    expect(fs.existsSync(path.join(mediaRoots.thumbDir, `${victim}.jpg`))).toBe(false)
    expect(fs.existsSync(path.join(mediaRoots.thumbDir, `${victim}.jpg.placeholder`))).toBe(false)
    expect(fs.existsSync(path.join(mediaRoots.previewDir, `${victim}.jpg`))).toBe(false)
    expect(fs.existsSync(keepCache)).toBe(true)
  })

  it('deleteBatch propagates BatchNotFoundError for an unknown id', async () => {
    const { handlers } = setup()
    await handlers.createBatch()
    await expectRejectName(() => handlers.deleteBatch(999_999), 'BatchNotFoundError')
  })

  it('renameBatch updates the name visible in listBatches', async () => {
    const { handlers } = setup()
    const first = await handlers.createBatch('first')
    await handlers.createBatch('second')

    await handlers.renameBatch(first.id, '婚礼正片')

    const batches = await handlers.listBatches()
    expect(batches).toHaveLength(2)
    expect(batches.find((b) => b.id === first.id)?.name).toBe('婚礼正片')
    // The untouched batch keeps its name.
    expect(batches.find((b) => b.name === 'second')).toBeDefined()
  })

  it('renameBatch propagates BatchNotFoundError for an unknown id', async () => {
    const { handlers } = setup()
    await handlers.createBatch()
    await expectRejectName(() => handlers.renameBatch(999_999, 'x'), 'BatchNotFoundError')
  })

  it('undo returns false when the batch has no undoable group', async () => {
    const { handlers } = setup()
    const batch = await handlers.createBatch()
    expect(await handlers.undo(batch.id)).toBe(false)
  })

  it('getSession/saveSession delegate straight to the injected session store', async () => {
    const { handlers, sessionStore } = setup()
    const read = vi.mocked(sessionStore.read)
    const write = vi.mocked(sessionStore.write)

    expect(await handlers.getSession()).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)

    const state: SessionState = { batchId: 5, view: { kind: 'folder', folderId: 9 } }
    await handlers.saveSession(state)
    expect(write).toHaveBeenCalledWith(state)

    read.mockReturnValue(state)
    expect(await handlers.getSession()).toEqual(state)
  })
})

describe('IPC handler contract — export manifest', () => {
  it('writes a manifest with folder grouping, posix relative paths and trash/empty-folder exclusion', async () => {
    const { handlers } = setup()
    const batch = await handlers.createBatch()
    const pick = await handlers.createFolder(batch.id, '精选')
    const travel = await handlers.createFolder(batch.id, '旅行')
    await handlers.createFolder(batch.id, '空文件夹')
    const root = makeFixtureTree()
    await handlers.importDirectory(batch.id, root)
    const inbox = await handlers.listView(batch.id, { kind: 'inbox' })
    const byPath = new Map(inbox.map((p) => [p.absPath, p.id]))
    const a = byPath.get(path.join(root, 'a.jpg'))!
    const b = byPath.get(path.join(root, 'b.png'))!
    const c = byPath.get(path.join(root, 'sub', 'c.webp'))!
    const d = byPath.get(path.join(root, 'sub', 'nested', 'd.arw'))!

    await handlers.assign([a, b], pick.id)
    await handlers.assign([c, d], travel.id)
    await handlers.trash([d])

    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-ipc-export-'))
    dirs.push(output)
    const target = path.join(output, 'manifest.json')
    const result = await handlers.exportManifest(batch.id, target)

    expect(result).toEqual({
      targetPath: target,
      folderCount: 2,
      photoCount: 3,
      missingCount: 0
    })

    const manifest = JSON.parse(fs.readFileSync(target, 'utf8')) as Manifest
    expect(manifest.kind).toBe('selight-manifest')
    expect(manifest.sources).toEqual([
      { id: manifest.sources[0]?.id, root: root.split(path.sep).join('/') }
    ])
    expect(manifest.folders.map((f) => f.name).sort()).toEqual(['旅行', '精选'])
    const travelGroup = manifest.folders.find((f) => f.name === '旅行')!
    expect(travelGroup.photos.map((p) => p.filename)).toEqual(['c.webp'])
    expect(travelGroup.photos[0].path).toBe('sub/c.webp')
    const allNames = manifest.folders.flatMap((f) => f.photos.map((p) => p.filename))
    expect(allNames).not.toContain('d.arw')
    expect(walkFiles(output).map((f) => path.basename(f))).not.toContain('manifest.json.tmp')
  })

  it('keeps DB-flagged missing photos in the manifest with missing:true and counts them', async () => {
    const { handlers, db } = setup()
    const batch = await handlers.createBatch()
    const folder = await handlers.createFolder(batch.id, '精选')
    const root = makeFixtureTree()
    await handlers.importDirectory(batch.id, root)
    const inbox = await handlers.listView(batch.id, { kind: 'inbox' })
    await handlers.assign(
      inbox.map((p) => p.id),
      folder.id
    )
    const victim = inbox.find((p) => p.filename === 'b.png')!
    // The manifest never touches disk: missing is a database flag set by re-scan,
    // not a runtime fs check, so flip it directly to simulate that state.
    db.prepare('UPDATE photos SET missing = 1 WHERE id = ?').run(victim.id)

    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-ipc-export-'))
    dirs.push(output)
    const target = path.join(output, 'manifest.json')
    const result = await handlers.exportManifest(batch.id, target)

    expect(result.missingCount).toBe(1)
    const manifest = JSON.parse(fs.readFileSync(target, 'utf8')) as Manifest
    const entry = manifest.folders[0].photos.find((p) => p.filename === 'b.png')!
    expect(entry.missing).toBe(true)
  })
})

// The preload cannot run under bare Node, so the push-event path is split: the channel
// constant and the API type shape are pinned here, while the real ipcRenderer.on delivery
// across the contextBridge (sandbox:true) is proven by the throwaway Electron dev harness.
describe('window.selight db-recovery push surface', () => {
  it('pins the recovery channel constant and the onDbRecovered subscription shape', () => {
    expect(IPC_CHANNELS.dbRecovered).toBe('selight:db:recovered')
    expect(IPC_CHANNELS.sessionGet).toBe('selight:session:get')
    expect(IPC_CHANNELS.sessionSave).toBe('selight:session:save')

    // Type-level structural assertion, erased at runtime but enforced by tsc:
    // SelightApi must expose onDbRecovered as (cb: () => void) => unsubscribe.
    const probe: SelightApi['onDbRecovered'] = (cb) => {
      cb()
      return () => {}
    }
    expect(typeof probe).toBe('function')
  })

  it('pins the manifest export channels and the dialog/shell seam shapes', () => {
    expect(IPC_CHANNELS.exportManifest).toBe('selight:export:manifest')
    expect(IPC_CHANNELS.dialogPickExportFile).toBe(
      'selight:dialog:pick-export-file'
    )
    expect(IPC_CHANNELS.shellOpenPath).toBe('selight:shell:open-path')

    // Structural probes, enforced by tsc against the SelightApi bridge contract.
    const picker: SelightApi['pickExportFile'] = async () => null
    const opener: SelightApi['openPath'] = async () => undefined
    const exporter: SelightApi['exportManifest'] = async () => ({
      targetPath: 'x.json',
      folderCount: 0,
      photoCount: 0,
      missingCount: 0
    })
    expect([typeof picker, typeof opener, typeof exporter]).toEqual([
      'function',
      'function',
      'function'
    ])
  })
})
