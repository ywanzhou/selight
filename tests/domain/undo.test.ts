import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { createFolder, listFolders } from '../../electron/domain/folders'
import { counts, upsertPhoto, type PhotoInput } from '../../electron/domain/photos'
import {
  assignToFolder,
  deleteFolderWithPhotos,
  moveToTrash,
  restoreFromTrash
} from '../../electron/domain/classify'
import { undoLastGroup } from '../../electron/domain/actions'

const dirs: string[] = []
const handles: Database[] = []

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-undo-'))
  dirs.push(dir)
  return path.join(dir, 'selight.db')
}

function tempDb(): { db: Database; file: string } {
  const file = tempDbPath()
  const { db } = openDatabase(file)
  handles.push(db)
  return { db, file }
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

function addSource(db: Database, batchId: number, absPath: string): number {
  const info = db
    .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
    .run(batchId, absPath)
  return Number(info.lastInsertRowid)
}

function addPhoto(db: Database, batchId: number, absPath: string): number {
  const input: PhotoInput = {
    batchId,
    sourceId: addSource(db, batchId, absPath),
    absPath,
    filename: path.basename(absPath),
    ext: path.extname(absPath),
    sizeBytes: 1024,
    mtime: 1_700_000_000_000,
    orientation: 1
  }
  return upsertPhoto(db, input).row.id
}

function photoState(
  db: Database,
  photoId: number
): { status: string; folder_id: number | null } {
  return db
    .prepare('SELECT status, folder_id FROM photos WHERE id = ?')
    .get(photoId) as { status: string; folder_id: number | null }
}

function undoneGroups(db: Database, batchId: number): number {
  return (
    db
      .prepare(
        'SELECT COUNT(DISTINCT batch_id_group) AS n FROM actions WHERE batch_id = ? AND undone = 1'
      )
      .get(batchId) as { n: number }
  ).n
}

describe('undo engine', () => {
  it('returns false when the batch has no undoable group', () => {
    const { db } = tempDb()
    const batch = createBatch(db)

    expect(undoLastGroup(db, batch.id)).toBe(false)
  })

  it('undoes a single assign: photo returns to inbox and counts are restored', () => {
    const { db } = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)
    expect(counts(db, batch.id)).toEqual({ total: 1, inbox: 0, folder: 1, trash: 0 })

    expect(undoLastGroup(db, batch.id)).toBe(true)

    expect(photoState(db, photoId)).toEqual({ status: 'inbox', folder_id: null })
    expect(counts(db, batch.id)).toEqual({ total: 1, inbox: 1, folder: 0, trash: 0 })
    expect(undoneGroups(db, batch.id)).toBe(1)
    // The undone group is never picked again.
    expect(undoLastGroup(db, batch.id)).toBe(false)
  })

  it('rolls back a 100-photo group with ONE undo call', () => {
    const { db } = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'big')
    const ids = Array.from({ length: 100 }, (_, i) =>
      addPhoto(db, batch.id, `E:/photos/p-${String(i).padStart(3, '0')}.jpg`)
    )
    assignToFolder(db, ids, folder.id)

    expect(undoLastGroup(db, batch.id)).toBe(true)

    expect(counts(db, batch.id)).toEqual({ total: 100, inbox: 100, folder: 0, trash: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM actions WHERE undone = 0').get() as { n: number }
    ).toEqual({ n: 0 })
    expect(undoLastGroup(db, batch.id)).toBe(false)
  })

  it('consecutive undos roll groups back in reverse order, then return false', () => {
    const { db } = tempDb()
    const batch = createBatch(db)
    const folderA = createFolder(db, batch.id, 'A')
    const folderB = createFolder(db, batch.id, 'B')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')

    assignToFolder(db, [photoId], folderA.id) // group 1: inbox -> A
    assignToFolder(db, [photoId], folderB.id) // group 2: A -> B

    expect(undoLastGroup(db, batch.id)).toBe(true)
    expect(photoState(db, photoId)).toEqual({ status: 'folder', folder_id: folderA.id })

    expect(undoLastGroup(db, batch.id)).toBe(true)
    expect(photoState(db, photoId)).toEqual({ status: 'inbox', folder_id: null })

    expect(undoLastGroup(db, batch.id)).toBe(false)
  })

  it('undoes deleteFolderWithPhotos: folder revives with original name and sort_order and photos return to it', () => {
    const { db } = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const originalSortOrder = folder.sortOrder
    const ids = [
      addPhoto(db, batch.id, 'E:/photos/a.jpg'),
      addPhoto(db, batch.id, 'E:/photos/b.jpg')
    ]
    assignToFolder(db, ids, folder.id)

    expect(deleteFolderWithPhotos(db, folder.id)).toBe(2)
    expect(listFolders(db, batch.id).map((f) => f.id)).not.toContain(folder.id)
    expect(counts(db, batch.id)).toEqual({ total: 2, inbox: 2, folder: 0, trash: 0 })

    expect(undoLastGroup(db, batch.id)).toBe(true)

    const revived = listFolders(db, batch.id).find((f) => f.id === folder.id)!
    expect(revived).toBeDefined()
    expect(revived.name).toBe('精选')
    expect(revived.sortOrder).toBe(originalSortOrder)
    for (const id of ids) {
      expect(photoState(db, id)).toEqual({ status: 'folder', folder_id: folder.id })
    }
    expect(counts(db, batch.id)).toEqual({ total: 2, inbox: 0, folder: 2, trash: 0 })
  })

  it('revives a folder under "原名 (恢复 N)" when a live folder already holds its name', () => {
    const { db } = tempDb()
    const batch = createBatch(db)
    const oldFolder = createFolder(db, batch.id, 'A')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], oldFolder.id)
    deleteFolderWithPhotos(db, oldFolder.id)

    // A new live folder takes the freed name while the old one stays soft-deleted.
    const newFolder = createFolder(db, batch.id, 'A')
    expect(newFolder.id).not.toBe(oldFolder.id)

    expect(undoLastGroup(db, batch.id)).toBe(true)

    const live = listFolders(db, batch.id)
    expect(live.map((f) => f.id).sort((x, y) => x - y)).toEqual(
      [oldFolder.id, newFolder.id].sort((x, y) => x - y)
    )
    const revivedOld = live.find((f) => f.id === oldFolder.id)!
    expect(revivedOld.name).toBe('A (恢复 1)')
    expect(live.find((f) => f.id === newFolder.id)!.name).toBe('A')
    // The photo returns to the revived OLD folder, not the new same-named one.
    expect(photoState(db, photoId)).toEqual({
      status: 'folder',
      folder_id: oldFolder.id
    })
  })

  it('undoes restoreFromTrash, sending the photo back to trash', () => {
    const { db } = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)
    moveToTrash(db, [photoId])
    restoreFromTrash(db, [photoId])
    expect(photoState(db, photoId)).toEqual({ status: 'folder', folder_id: folder.id })

    expect(undoLastGroup(db, batch.id)).toBe(true)

    expect(photoState(db, photoId)).toEqual({ status: 'trash', folder_id: folder.id })
    expect(counts(db, batch.id)).toEqual({ total: 1, inbox: 0, folder: 0, trash: 1 })
  })

  it('picks "原名 (恢复 2)" when both the original name and "原名 (恢复 1)" are taken by live folders', () => {
    const { db } = tempDb()
    const batch = createBatch(db)
    const oldFolder = createFolder(db, batch.id, 'A')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], oldFolder.id)
    deleteFolderWithPhotos(db, oldFolder.id)
    createFolder(db, batch.id, 'A')
    createFolder(db, batch.id, 'A (恢复 1)')

    expect(undoLastGroup(db, batch.id)).toBe(true)

    const revivedOld = listFolders(db, batch.id).find((f) => f.id === oldFolder.id)!
    expect(revivedOld.name).toBe('A (恢复 2)')
    expect(listFolders(db, batch.id)).toHaveLength(3)
    expect(photoState(db, photoId)).toEqual({
      status: 'folder',
      folder_id: oldFolder.id
    })
  })

  it('keeps undo scoped per batch: undoing batch A never touches batch B', () => {
    const { db } = tempDb()
    const batchA = createBatch(db, 'a')
    const batchB = createBatch(db, 'b')
    const folderA = createFolder(db, batchA.id, 'fa')
    const folderB = createFolder(db, batchB.id, 'fb')
    const photoA = addPhoto(db, batchA.id, 'E:/a/1.jpg')
    const photoB = addPhoto(db, batchB.id, 'E:/b/1.jpg')
    assignToFolder(db, [photoA], folderA.id)
    assignToFolder(db, [photoB], folderB.id)

    expect(undoLastGroup(db, batchA.id)).toBe(true)
    expect(photoState(db, photoA)).toEqual({ status: 'inbox', folder_id: null })
    // Batch B is completely untouched: photo state and undone flags both.
    expect(photoState(db, photoB)).toEqual({ status: 'folder', folder_id: folderB.id })
    expect(undoneGroups(db, batchB.id)).toBe(0)

    // A has nothing left to undo while B still does — proving the scoping.
    expect(undoLastGroup(db, batchA.id)).toBe(false)
    expect(undoLastGroup(db, batchB.id)).toBe(true)
    expect(photoState(db, photoB)).toEqual({ status: 'inbox', folder_id: null })
  })

  it('still undoes after closing and reopening the database through openDatabase', () => {
    const { db, file } = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)
    db.close()

    const reopened = openDatabase(file).db
    handles.push(reopened)

    expect(undoLastGroup(reopened, batch.id)).toBe(true)
    expect(
      (reopened
        .prepare('SELECT status, folder_id FROM photos WHERE id = ?')
        .get(photoId) as { status: string; folder_id: number | null })
    ).toEqual({ status: 'inbox', folder_id: null })
    expect(undoLastGroup(reopened, batch.id)).toBe(false)
  })
})
