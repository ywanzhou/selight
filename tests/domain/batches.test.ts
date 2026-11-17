import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import {
  BatchNotFoundError,
  createBatch,
  deleteBatch,
  getBatch,
  listBatches,
  renameBatch,
  touchBatch
} from '../../electron/domain/batches'
import { createFolder } from '../../electron/domain/folders'
import { upsertPhoto } from '../../electron/domain/photos'
import { assignToFolder } from '../../electron/domain/classify'

const dirs: string[] = []
const handles: Database[] = []

function tempDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-batches-'))
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

function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Spin until the epoch-millisecond clock advances, so ordering assertions stay deterministic.
function nextTick(): void {
  const t = Date.now()
  while (Date.now() === t) {
    /* busy wait */
  }
}

describe('batch domain module', () => {
  it('createBatch defaults the name to the local YYYY-MM-DD date and sets lastOpenedAt', () => {
    const db = tempDb()
    const before = Date.now()
    const batch = createBatch(db)
    const after = Date.now()

    expect(batch.name).toBe(localDate())
    expect(batch.id).toBeGreaterThan(0)
    expect(Number.isInteger(batch.createdAt)).toBe(true)
    expect(Number.isInteger(batch.lastOpenedAt)).toBe(true)
    expect(batch.lastOpenedAt).toBeGreaterThanOrEqual(before)
    expect(batch.lastOpenedAt).toBeLessThanOrEqual(after)
  })

  it('createBatch uses an explicit name when given', () => {
    const db = tempDb()
    const batch = createBatch(db, '婚礼 A')
    expect(batch.name).toBe('婚礼 A')
    expect(getBatch(db, batch.id)?.name).toBe('婚礼 A')
  })

  it('lists batches with the most recently opened first', () => {
    const db = tempDb()
    const first = createBatch(db, 'first')
    nextTick()
    const second = createBatch(db, 'second')

    const rows = listBatches(db)
    expect(rows.map((b) => b.id)).toEqual([second.id, first.id])
    expect(rows[0]).toEqual(second)
  })

  it('returns an empty list when no batches exist', () => {
    expect(listBatches(tempDb())).toEqual([])
  })

  it('touchBatch updates lastOpenedAt without touching createdAt', () => {
    const db = tempDb()
    const batch = createBatch(db)
    nextTick()
    touchBatch(db, batch.id)

    const updated = getBatch(db, batch.id)!
    expect(updated.lastOpenedAt).toBeGreaterThan(batch.lastOpenedAt)
    expect(updated.createdAt).toBe(batch.createdAt)
    expect(updated.name).toBe(batch.name)
  })

  it('getBatch returns undefined for an unknown id', () => {
    const db = tempDb()
    expect(getBatch(db, 9999)).toBeUndefined()
  })

  it('deleteBatch removes the batch and all its child rows in one transaction, returning photo ids', () => {
    const db = tempDb()
    const batch = createBatch(db, '婚礼')
    const other = createBatch(db, 'other')
    const folder = createFolder(db, batch.id, '精选')
    const sourceId = Number(
      db.prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)').run(batch.id, 'E:/a')
        .lastInsertRowid
    )
    const photoId = upsertPhoto(db, {
      batchId: batch.id,
      sourceId,
      absPath: 'E:/a/1.jpg',
      filename: '1.jpg',
      ext: '.jpg',
      sizeBytes: 1,
      mtime: 1
    }).row.id
    // Produces an actions row referencing the batch, photo and folder.
    assignToFolder(db, [photoId], folder.id)

    expect(deleteBatch(db, batch.id)).toEqual([photoId])

    expect(getBatch(db, batch.id)).toBeUndefined()
    expect(listBatches(db).map((b) => b.id)).toEqual([other.id])
    for (const table of ['photos', 'folders', 'sources', 'actions']) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      expect(n).toBe(0)
    }
  })

  it('renameBatch changes the name without touching last_opened_at or ordering', () => {
    const db = tempDb()
    nextTick()
    const first = createBatch(db, 'first')
    nextTick()
    const second = createBatch(db, 'second')
    const before = getBatch(db, first.id)!

    renameBatch(db, first.id, '婚礼正片')

    const after = getBatch(db, first.id)!
    expect(after.name).toBe('婚礼正片')
    expect(after.lastOpenedAt).toBe(before.lastOpenedAt)
    expect(after.createdAt).toBe(before.createdAt)
    // Dropdown order is last_opened_at DESC and must not move on a rename.
    expect(listBatches(db).map((b) => b.id)).toEqual([second.id, first.id])
  })

  it('renameBatch throws BatchNotFoundError on an unknown id', () => {
    const db = tempDb()
    const batch = createBatch(db)
    expect(() => renameBatch(db, 9999, 'x')).toThrowError(BatchNotFoundError)
    expect(getBatch(db, batch.id)?.name).toBe(batch.name)
  })

  it('deleteBatch throws BatchNotFoundError on an unknown id and changes nothing', () => {
    const db = tempDb()
    const batch = createBatch(db)

    expect(() => deleteBatch(db, 9999)).toThrowError(BatchNotFoundError)
    expect(getBatch(db, batch.id)).toBeDefined()
    expect(listBatches(db)).toHaveLength(1)
  })
})
