import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { createFolder } from '../../electron/domain/folders'
import {
  counts,
  listPhotos,
  markMissing,
  upsertPhoto,
  type PhotoInput
} from '../../electron/domain/photos'

const dirs: string[] = []
const handles: Database[] = []

function tempDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-photos-'))
  dirs.push(dir)
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)
  return db
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

// Spin until the epoch-millisecond clock advances, so ordering assertions stay deterministic.
function nextTick(): void {
  const t = Date.now()
  while (Date.now() === t) {
    /* busy wait */
  }
}

function addSource(db: Database, batchId: number, absPath: string): number {
  const info = db
    .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
    .run(batchId, absPath)
  return Number(info.lastInsertRowid)
}

function makeInput(
  db: Database,
  batchId: number,
  absPath: string,
  overrides: Partial<PhotoInput> = {}
): PhotoInput {
  return {
    batchId,
    sourceId: addSource(db, batchId, absPath),
    absPath,
    filename: path.basename(absPath),
    ext: path.extname(absPath),
    sizeBytes: 1024,
    mtime: 1_700_000_000_000,
    orientation: 1,
    ...overrides
  }
}

function setStatus(
  db: Database,
  photoId: number,
  status: 'inbox' | 'folder' | 'trash',
  folderId: number | null = null
): void {
  db.prepare('UPDATE photos SET status = ?, folder_id = ? WHERE id = ?').run(
    status,
    folderId,
    photoId
  )
}

function photoCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n
}

describe('photo domain module', () => {
  it('upsertPhoto inserts a new photo with inbox defaults and camelCase fields', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const input = makeInput(db, batch.id, 'E:/photos/a.jpg')
    const before = Date.now()
    const { row, created } = upsertPhoto(db, input)
    const after = Date.now()

    expect(created).toBe(true)
    expect(row.id).toBeGreaterThan(0)
    expect(row).toMatchObject(input)
    expect(row.status).toBe('inbox')
    expect(row.folderId).toBeNull()
    expect(row.missing).toBe(0)
    expect(row.width).toBeNull()
    expect(row.height).toBeNull()
    expect(row.thumbPath).toBeNull()
    expect(row.previewPath).toBeNull()
    expect(Number.isInteger(row.createdAt)).toBe(true)
    expect(Number.isInteger(row.updatedAt)).toBe(true)
    // SQL defaults floor epoch millis to the second; allow the same tolerance as the folders suite.
    expect(row.createdAt).toBeGreaterThanOrEqual(before - 1000)
    expect(row.updatedAt).toBeLessThanOrEqual(after + 1000)
  })

  it('re-upserts the same batch + absPath with created=false and no new row', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const input = makeInput(db, batch.id, 'E:/photos/a.jpg')

    const first = upsertPhoto(db, input)
    const second = upsertPhoto(db, input)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.row.id).toBe(first.row.id)
    expect(photoCount(db)).toBe(1)
  })

  it('re-upsert resolves to the original row when last_insert_rowid has moved on', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const input = makeInput(db, batch.id, 'E:/photos/a.jpg')
    const first = upsertPhoto(db, input)
    expect(first.created).toBe(true)

    // A rescan inserts sources before re-upserting photos, moving the connection's
    // last_insert_rowid away from the photo's rowid (source ids 2..4 vs photo id 1).
    addSource(db, batch.id, 'E:/photos/extra-1.jpg')
    addSource(db, batch.id, 'E:/photos/extra-2.jpg')
    addSource(db, batch.id, 'E:/photos/extra-3.jpg')

    // No-op conflict: unchanged mtime makes the ON CONFLICT WHERE skip the UPDATE,
    // so last_insert_rowid is guaranteed to stay at the stale sources rowid.
    const noop = upsertPhoto(db, input)
    expect(noop.created).toBe(false)
    expect(noop.row.id).toBe(first.row.id)
    expect(noop.row.absPath).toBe(first.row.absPath)

    // The update conflict path (mtime changed) must also resolve to the same row.
    const updated = upsertPhoto(db, { ...input, mtime: input.mtime + 1000 })
    expect(updated.created).toBe(false)
    expect(updated.row.id).toBe(first.row.id)
    expect(updated.row.absPath).toBe(first.row.absPath)
    expect(updated.row.mtime).toBe(input.mtime + 1000)

    expect(photoCount(db)).toBe(1)
  })

  it('treats the same absPath in a different batch as a separate photo', () => {
    const db = tempDb()
    const batchA = createBatch(db, 'a')
    const batchB = createBatch(db, 'b')
    const inputA = makeInput(db, batchA.id, 'E:/shared/a.jpg')
    const inputB = makeInput(db, batchB.id, 'E:/shared/a.jpg')

    const rowA = upsertPhoto(db, inputA)
    const rowB = upsertPhoto(db, inputB)

    expect(rowA.created).toBe(true)
    expect(rowB.created).toBe(true)
    expect(rowB.row.id).not.toBe(rowA.row.id)
    expect(photoCount(db)).toBe(2)
  })

  it('refreshes scan fields and updatedAt when mtime changes, preserving user state', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const input = makeInput(db, batch.id, 'E:/photos/a.jpg')
    const first = upsertPhoto(db, input)
    setStatus(db, first.row.id, 'folder', folder.id)

    // An unchanged re-scan does not touch updatedAt.
    expect(upsertPhoto(db, input).row.updatedAt).toBe(first.row.updatedAt)

    nextTick()
    const refreshed = upsertPhoto(db, {
      ...input,
      mtime: input.mtime + 5000,
      sizeBytes: 2048,
      filename: 'renamed.jpg'
    })

    expect(refreshed.created).toBe(false)
    expect(refreshed.row.id).toBe(first.row.id)
    expect(refreshed.row.mtime).toBe(input.mtime + 5000)
    expect(refreshed.row.sizeBytes).toBe(2048)
    expect(refreshed.row.filename).toBe('renamed.jpg')
    expect(refreshed.row.updatedAt).toBeGreaterThan(first.row.updatedAt)
    expect(refreshed.row.createdAt).toBe(first.row.createdAt)
    // Curation state and generated-asset columns survive the re-scan.
    expect(refreshed.row.status).toBe('folder')
    expect(refreshed.row.folderId).toBe(folder.id)
    expect(refreshed.row.missing).toBe(0)
    expect(photoCount(db)).toBe(1)
  })

  it('listPhotos filters each view and orders rows by absPath', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const f1 = createFolder(db, batch.id, 'f1')
    const f2 = createFolder(db, batch.id, 'f2')

    const paths = [
      'E:/photos/z-inbox.jpg',
      'E:/photos/a-inbox.jpg',
      'E:/photos/m-folder1.jpg',
      'E:/photos/b-folder2.jpg',
      'E:/photos/c-trash.jpg'
    ]
    const rows = paths.map((p) => upsertPhoto(db, makeInput(db, batch.id, p)).row)
    setStatus(db, rows[2].id, 'folder', f1.id)
    setStatus(db, rows[3].id, 'folder', f2.id)
    setStatus(db, rows[4].id, 'trash')

    const inbox = listPhotos(db, batch.id, { kind: 'inbox' })
    expect(inbox.map((r) => r.absPath)).toEqual([
      'E:/photos/a-inbox.jpg',
      'E:/photos/z-inbox.jpg'
    ])
    expect(inbox.every((r) => r.status === 'inbox')).toBe(true)

    const folder1 = listPhotos(db, batch.id, { kind: 'folder', folderId: f1.id })
    expect(folder1.map((r) => r.id)).toEqual([rows[2].id])
    // The other folder's photo and inbox/trash photos are excluded.
    const folder2 = listPhotos(db, batch.id, { kind: 'folder', folderId: f2.id })
    expect(folder2.map((r) => r.id)).toEqual([rows[3].id])

    const trash = listPhotos(db, batch.id, { kind: 'trash' })
    expect(trash.map((r) => r.id)).toEqual([rows[4].id])
  })

  it('listPhotos returns an empty list for an unknown batch or empty view', () => {
    const db = tempDb()
    const batch = createBatch(db)
    expect(listPhotos(db, batch.id, { kind: 'inbox' })).toEqual([])
    expect(listPhotos(db, 9999, { kind: 'trash' })).toEqual([])
    expect(listPhotos(db, 9999, { kind: 'folder', folderId: 1 })).toEqual([])
  })

  it('counts reports total and per-status totals for a batch', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const other = createBatch(db, 'other')
    const f1 = createFolder(db, batch.id, 'f1')

    for (const p of ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']) {
      const row = upsertPhoto(db, makeInput(db, batch.id, `E:/photos/${p}`)).row
      if (p === '3.jpg' || p === '4.jpg') setStatus(db, row.id, 'folder', f1.id)
      if (p === '5.jpg') setStatus(db, row.id, 'trash')
    }
    upsertPhoto(db, makeInput(db, other.id, 'E:/other/x.jpg'))

    expect(counts(db, batch.id)).toEqual({ total: 5, inbox: 2, folder: 2, trash: 1 })
    expect(counts(db, other.id)).toEqual({ total: 1, inbox: 1, folder: 0, trash: 0 })
    expect(counts(db, 9999)).toEqual({ total: 0, inbox: 0, folder: 0, trash: 0 })
  })

  it('markMissing flags absent paths, returns the affected count, and stays batch-scoped', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const other = createBatch(db, 'other')

    const p1 = upsertPhoto(db, makeInput(db, batch.id, 'E:/photos/1.jpg')).row
    const p2 = upsertPhoto(db, makeInput(db, batch.id, 'E:/photos/2.jpg')).row
    const p3 = upsertPhoto(db, makeInput(db, batch.id, 'E:/photos/3.jpg')).row
    const otherRow = upsertPhoto(db, makeInput(db, other.id, 'E:/other/x.jpg')).row

    const affected = markMissing(db, batch.id, new Set([p1.absPath, p2.absPath]))
    expect(affected).toBe(1)

    const reloaded = listPhotos(db, batch.id, { kind: 'inbox' })
    expect(reloaded.find((r) => r.id === p1.id)?.missing).toBe(0)
    expect(reloaded.find((r) => r.id === p2.id)?.missing).toBe(0)
    expect(reloaded.find((r) => r.id === p3.id)?.missing).toBe(1)
    expect(otherRow.missing).toBe(0)

    // Already-flagged rows are not counted again.
    expect(markMissing(db, batch.id, new Set([p1.absPath, p2.absPath]))).toBe(0)

    // An empty existence set flags every not-yet-flagged row in the batch.
    expect(markMissing(db, batch.id, new Set())).toBe(2)
    expect(markMissing(db, other.id, new Set())).toBe(1)
  })
})
