import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import {
  FolderNameConflictError,
  createFolder,
  listFolders,
  renameFolder,
  softDeleteFolder
} from '../../electron/domain/folders'

const dirs: string[] = []
const handles: Database[] = []

function tempDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-folders-'))
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

describe('folder domain module', () => {
  it('createFolder starts sortOrder at 1 and increments per batch', () => {
    const db = tempDb()
    const batch = createBatch(db)

    const first = createFolder(db, batch.id, '合影')
    const second = createFolder(db, batch.id, '精选')
    expect(first.sortOrder).toBe(1)
    expect(second.sortOrder).toBe(2)
    expect(first.id).not.toBe(second.id)
  })

  it('supports Chinese names and very long names', () => {
    const db = tempDb()
    const batch = createBatch(db)

    const chinese = createFolder(db, batch.id, '婚礼现场·亲友合影')
    expect(chinese.name).toBe('婚礼现场·亲友合影')
    const long = createFolder(db, batch.id, '名'.repeat(500))
    expect(long.name).toBe('名'.repeat(500))
  })

  it('returns FolderRow fields with camelCase keys and epoch-millis timestamps', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const before = Date.now()
    const folder = createFolder(db, batch.id, 'f')
    const after = Date.now()

    expect(folder.batchId).toBe(batch.id)
    expect(folder.deletedAt).toBeNull()
    expect(Number.isInteger(folder.createdAt)).toBe(true)
    expect(folder.createdAt).toBeGreaterThanOrEqual(before - 1000)
    expect(folder.createdAt).toBeLessThanOrEqual(after + 1000)
  })

  it('throws FolderNameConflictError on a duplicate live name in the same batch', () => {
    const db = tempDb()
    const batch = createBatch(db)
    createFolder(db, batch.id, '合影')

    expect(() => createFolder(db, batch.id, '合影')).toThrowError(FolderNameConflictError)
    expect(() => createFolder(db, batch.id, '合影')).toThrowError(/合影/)
  })

  it('allows the same name in different batches', () => {
    const db = tempDb()
    const a = createBatch(db, 'a')
    const b = createBatch(db, 'b')

    expect(createFolder(db, a.id, '同名').name).toBe('同名')
    expect(createFolder(db, b.id, '同名').name).toBe('同名')
  })

  it('renameFolder changes the name and throws FolderNameConflictError on a live duplicate', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const first = createFolder(db, batch.id, 'a')
    const second = createFolder(db, batch.id, 'b')

    renameFolder(db, first.id, 'renamed')
    expect(listFolders(db, batch.id).find((f) => f.id === first.id)?.name).toBe('renamed')

    expect(() => renameFolder(db, second.id, 'renamed')).toThrowError(FolderNameConflictError)
    // Renaming a folder to its own current name is not a conflict.
    expect(() => renameFolder(db, second.id, 'b')).not.toThrow()
  })

  it('softDeleteFolder stamps deletedAt and hides the folder from listFolders', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'trash-me')
    const before = Date.now()
    softDeleteFolder(db, folder.id)
    const after = Date.now()

    const row = db
      .prepare('SELECT deleted_at FROM folders WHERE id = ?')
      .get(folder.id) as { deleted_at: number }
    expect(row.deleted_at).toBeGreaterThanOrEqual(before)
    expect(row.deleted_at).toBeLessThanOrEqual(after)
    expect(listFolders(db, batch.id)).toEqual([])
  })

  it('allows recreating a soft-deleted name, and keeps sortOrder based on live folders', () => {
    const db = tempDb()
    const batch = createBatch(db)
    createFolder(db, batch.id, '合影')
    const second = createFolder(db, batch.id, 'temp')
    softDeleteFolder(db, second.id)

    const recreated = createFolder(db, batch.id, 'temp')
    expect(recreated.id).not.toBe(second.id)
    // Only the first folder is live, so max live sort_order (1) + 1 = 2.
    expect(recreated.sortOrder).toBe(2)
  })

  it('listFolders returns only live folders ordered by sortOrder', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const f1 = createFolder(db, batch.id, 'one')
    const f2 = createFolder(db, batch.id, 'two')
    const f3 = createFolder(db, batch.id, 'three')
    softDeleteFolder(db, f2.id)

    const rows = listFolders(db, batch.id)
    expect(rows.map((f) => f.id)).toEqual([f1.id, f3.id])
    expect(rows.every((f) => f.deletedAt === null)).toBe(true)
  })

  it('returns an empty list when the batch has no live folders', () => {
    const db = tempDb()
    const batch = createBatch(db)
    expect(listFolders(db, batch.id)).toEqual([])
  })
})
