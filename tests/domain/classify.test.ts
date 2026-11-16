import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { createFolder, softDeleteFolder } from '../../electron/domain/folders'
import { counts, listPhotos, upsertPhoto, type PhotoInput } from '../../electron/domain/photos'
import {
  FolderNotFoundError,
  MixedBatchError,
  assignToFolder,
  deleteFolderWithPhotos,
  moveToTrash,
  restoreFromTrash
} from '../../electron/domain/classify'
import { listFolders } from '../../electron/domain/folders'
import { undoLastGroup } from '../../electron/domain/actions'

const dirs: string[] = []
const handles: Database[] = []

function tempDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-classify-'))
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

function addSource(db: Database, batchId: number, absPath: string): number {
  const info = db
    .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
    .run(batchId, absPath)
  return Number(info.lastInsertRowid)
}

function makeInput(
  db: Database,
  batchId: number,
  absPath: string
): PhotoInput {
  return {
    batchId,
    sourceId: addSource(db, batchId, absPath),
    absPath,
    filename: path.basename(absPath),
    ext: path.extname(absPath),
    sizeBytes: 1024,
    mtime: 1_700_000_000_000,
    orientation: 1
  }
}

function addPhoto(db: Database, batchId: number, absPath: string): number {
  return upsertPhoto(db, makeInput(db, batchId, absPath)).row.id
}

interface ActionRow {
  id: number
  batch_id: number
  batch_id_group: number
  photo_id: number
  from_status: string | null
  from_folder_id: number | null
  to_status: string
  to_folder_id: number | null
  undone: number
}

function listActions(db: Database, batchId: number): ActionRow[] {
  return db
    .prepare('SELECT * FROM actions WHERE batch_id = ? ORDER BY id')
    .all(batchId) as ActionRow[]
}

function actionCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number }).n
}

function distinctGroups(db: Database, batchId: number): number {
  return (
    db
      .prepare(
        'SELECT COUNT(DISTINCT batch_id_group) AS n FROM actions WHERE batch_id = ?'
      )
      .get(batchId) as { n: number }
  ).n
}

function photoState(
  db: Database,
  photoId: number
): { status: string; folder_id: number | null } {
  return db
    .prepare('SELECT status, folder_id FROM photos WHERE id = ?')
    .get(photoId) as { status: string; folder_id: number | null }
}

describe('classification actions', () => {
  it('assignToFolder moves photos out of inbox into the folder and logs exact from/to rows', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const ids = [
      addPhoto(db, batch.id, 'E:/photos/a.jpg'),
      addPhoto(db, batch.id, 'E:/photos/b.jpg')
    ]

    const affected = assignToFolder(db, ids, folder.id)

    expect(affected).toBe(2)
    expect(counts(db, batch.id)).toEqual({ total: 2, inbox: 0, folder: 2, trash: 0 })
    expect(listPhotos(db, batch.id, { kind: 'folder', folderId: folder.id })).toHaveLength(2)
    expect(photoState(db, ids[0])).toEqual({ status: 'folder', folder_id: folder.id })

    const actions = listActions(db, batch.id)
    expect(actions).toHaveLength(2)
    expect(distinctGroups(db, batch.id)).toBe(1)
    expect(
      actions.every(
        (a) =>
          a.batch_id_group === actions[0].batch_id_group &&
          a.from_status === 'inbox' &&
          a.from_folder_id === null &&
          a.to_status === 'folder' &&
          a.to_folder_id === folder.id &&
          a.undone === 0
      )
    ).toBe(true)
    expect(actions.map((a) => a.photo_id).sort((x, y) => x - y)).toEqual([...ids].sort())
  })

  it('gives a 100-photo call exactly one group with one action row per photo', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'big')
    const ids = Array.from({ length: 100 }, (_, i) =>
      addPhoto(db, batch.id, `E:/photos/p-${String(i).padStart(3, '0')}.jpg`)
    )

    expect(assignToFolder(db, ids, folder.id)).toBe(100)

    const actions = listActions(db, batch.id)
    expect(actions).toHaveLength(100)
    expect(distinctGroups(db, batch.id)).toBe(1)
    expect(new Set(actions.map((a) => a.photo_id))).toEqual(new Set(ids))
    expect(counts(db, batch.id)).toEqual({ total: 100, inbox: 0, folder: 100, trash: 0 })
  })

  it('every call gets its own new group, with the sequence isolated per batch', () => {
    const db = tempDb()
    const batchA = createBatch(db, 'a')
    const batchB = createBatch(db, 'b')
    const folderA = createFolder(db, batchA.id, 'fa')
    const folderB = createFolder(db, batchB.id, 'fb')
    const a1 = addPhoto(db, batchA.id, 'E:/a/1.jpg')
    const a2 = addPhoto(db, batchA.id, 'E:/a/2.jpg')
    const b1 = addPhoto(db, batchB.id, 'E:/b/1.jpg')

    assignToFolder(db, [a1], folderA.id)
    assignToFolder(db, [a2], folderA.id)
    assignToFolder(db, [b1], folderB.id)

    const groupsA = listActions(db, batchA.id).map((a) => a.batch_id_group)
    expect(groupsA).toEqual([1, 2])
    // Batch B has its own sequence starting at 1.
    expect(listActions(db, batchB.id).map((a) => a.batch_id_group)).toEqual([1])
  })

  it('moveToTrash keeps folder_id NULL when trashing from inbox', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')

    expect(moveToTrash(db, [photoId])).toBe(1)

    expect(photoState(db, photoId)).toEqual({ status: 'trash', folder_id: null })
    expect(counts(db, batch.id)).toEqual({ total: 1, inbox: 0, folder: 0, trash: 1 })
    const action = listActions(db, batch.id)[0]
    expect(action).toMatchObject({
      from_status: 'inbox',
      from_folder_id: null,
      to_status: 'trash',
      to_folder_id: null
    })
  })

  it('moveToTrash retains the previous folder id so restore can return there', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)

    expect(moveToTrash(db, [photoId])).toBe(1)
    expect(photoState(db, photoId)).toEqual({ status: 'trash', folder_id: folder.id })

    const trashAction = listActions(db, batch.id).at(-1)!
    expect(trashAction).toMatchObject({
      from_status: 'folder',
      from_folder_id: folder.id,
      to_status: 'trash',
      to_folder_id: folder.id
    })

    expect(restoreFromTrash(db, [photoId])).toBe(1)
    expect(photoState(db, photoId)).toEqual({ status: 'folder', folder_id: folder.id })
    const restoreAction = listActions(db, batch.id).at(-1)!
    expect(restoreAction).toMatchObject({
      from_status: 'trash',
      from_folder_id: folder.id,
      to_status: 'folder',
      to_folder_id: folder.id
    })
  })

  it('restoreFromTrash falls back to inbox when the original folder was soft-deleted', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'gone')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)
    moveToTrash(db, [photoId])
    softDeleteFolder(db, folder.id)

    expect(restoreFromTrash(db, [photoId])).toBe(1)

    expect(photoState(db, photoId)).toEqual({ status: 'inbox', folder_id: null })
    const restoreAction = listActions(db, batch.id).at(-1)!
    expect(restoreAction).toMatchObject({
      from_status: 'trash',
      from_folder_id: folder.id,
      to_status: 'inbox',
      to_folder_id: null
    })
  })

  it('restoreFromTrash returns an inbox-trashed photo to inbox with NULL folder', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    moveToTrash(db, [photoId])

    restoreFromTrash(db, [photoId])

    expect(photoState(db, photoId)).toEqual({ status: 'inbox', folder_id: null })
  })

  it('empty photoIds is a no-op returning 0 without creating any group or action rows', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'f')

    expect(assignToFolder(db, [], folder.id)).toBe(0)
    expect(moveToTrash(db, [])).toBe(0)
    expect(restoreFromTrash(db, [])).toBe(0)
    expect(actionCount(db)).toBe(0)
  })

  it('ignores unknown photo ids: affected count and action rows match only existing photos', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'f')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')

    expect(assignToFolder(db, [photoId, 999_999], folder.id)).toBe(1)
    expect(listActions(db, batch.id)).toHaveLength(1)
    expect(distinctGroups(db, batch.id)).toBe(1)
  })

  it('rejects mixed-batch photo ids in all three actions and rolls everything back', () => {
    const db = tempDb()
    const batchA = createBatch(db, 'a')
    const batchB = createBatch(db, 'b')
    const folderA = createFolder(db, batchA.id, 'fa')
    const photoA = addPhoto(db, batchA.id, 'E:/a/1.jpg')
    const photoB = addPhoto(db, batchB.id, 'E:/b/1.jpg')
    const mixed = [photoA, photoB]

    expect(() => assignToFolder(db, mixed, folderA.id)).toThrowError(MixedBatchError)
    expect(() => moveToTrash(db, mixed)).toThrowError(MixedBatchError)
    expect(() => restoreFromTrash(db, mixed)).toThrowError(MixedBatchError)

    // The transaction rolled back: no photo changed state and no audit row was written.
    expect(photoState(db, photoA)).toEqual({ status: 'inbox', folder_id: null })
    expect(photoState(db, photoB)).toEqual({ status: 'inbox', folder_id: null })
    expect(actionCount(db)).toBe(0)
  })

  it('assignToFolder migrates a photo between folders and logs folder/A → folder/B', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folderA = createFolder(db, batch.id, 'A')
    const folderB = createFolder(db, batch.id, 'B')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')

    assignToFolder(db, [photoId], folderA.id)
    expect(assignToFolder(db, [photoId], folderB.id)).toBe(1)

    expect(photoState(db, photoId)).toEqual({ status: 'folder', folder_id: folderB.id })
    const migration = listActions(db, batch.id).at(-1)!
    expect(migration).toMatchObject({
      from_status: 'folder',
      from_folder_id: folderA.id,
      to_status: 'folder',
      to_folder_id: folderB.id
    })
  })

  it('deleteFolderWithPhotos soft-deletes the folder and moves its folder photos to inbox in one group', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, '精选')
    const other = createFolder(db, batch.id, 'other')
    const inFolder = [
      addPhoto(db, batch.id, 'E:/photos/a.jpg'),
      addPhoto(db, batch.id, 'E:/photos/b.jpg')
    ]
    const trashedFromFolder = addPhoto(db, batch.id, 'E:/photos/c.jpg')
    const staysInOther = addPhoto(db, batch.id, 'E:/photos/d.jpg')
    assignToFolder(db, inFolder, folder.id)
    assignToFolder(db, [trashedFromFolder], folder.id)
    moveToTrash(db, [trashedFromFolder])
    assignToFolder(db, [staysInOther], other.id)

    const moved = deleteFolderWithPhotos(db, folder.id)

    expect(moved).toBe(2)
    expect(listFolders(db, batch.id).map((f) => f.id)).not.toContain(folder.id)
    for (const id of inFolder) {
      expect(photoState(db, id)).toEqual({ status: 'inbox', folder_id: null })
    }
    // Trash photos only retain the folder id; they are not folder photos and stay trashed.
    expect(photoState(db, trashedFromFolder)).toEqual({
      status: 'trash',
      folder_id: folder.id
    })
    expect(photoState(db, staysInOther)).toEqual({ status: 'folder', folder_id: other.id })

    const deleteActions = listActions(db, batch.id).filter(
      (a) => a.to_status === 'inbox' && a.to_folder_id === null && a.from_status === 'folder'
    )
    expect(deleteActions).toHaveLength(2)
    expect(distinctGroups(db, batch.id)).toBeGreaterThan(0)
    expect(new Set(deleteActions.map((a) => a.batch_id_group)).size).toBe(1)
    expect(
      deleteActions.every(
        (a) => a.from_folder_id === folder.id && a.undone === 0
      )
    ).toBe(true)
  })

  it('deleting an empty folder writes a NULL-photo marker and is fully undoable', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'empty')
    const originalSortOrder = folder.sortOrder

    expect(deleteFolderWithPhotos(db, folder.id)).toBe(0)

    expect(listFolders(db, batch.id).map((f) => f.id)).not.toContain(folder.id)
    // The marker row keeps the folder deletion itself undoable.
    const markers = db
      .prepare(
        `SELECT * FROM actions
         WHERE photo_id IS NULL AND from_status = 'folder' AND from_folder_id = ?
           AND to_status = 'inbox' AND to_folder_id IS NULL AND undone = 0`
      )
      .all(folder.id)
    expect(markers).toHaveLength(1)

    expect(undoLastGroup(db, batch.id)).toBe(true)
    const revived = listFolders(db, batch.id).find((f) => f.id === folder.id)!
    expect(revived).toBeDefined()
    expect(revived.name).toBe('empty')
    expect(revived.sortOrder).toBe(originalSortOrder)
    expect(undoLastGroup(db, batch.id)).toBe(false)
  })

  it('deleting a folder that only holds trashed photos writes a marker and undo leaves trash untouched', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'f')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)
    moveToTrash(db, [photoId])

    expect(deleteFolderWithPhotos(db, folder.id)).toBe(0)
    // Trash photos only retain the folder id; they are not moved by the folder deletion.
    expect(photoState(db, photoId)).toEqual({ status: 'trash', folder_id: folder.id })

    expect(undoLastGroup(db, batch.id)).toBe(true)
    expect(listFolders(db, batch.id).map((f) => f.id)).toContain(folder.id)
    expect(photoState(db, photoId)).toEqual({ status: 'trash', folder_id: folder.id })
  })

  it('deleteFolderWithPhotos throws FolderNotFoundError on unknown or already-deleted ids and rolls back', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'f')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)

    expect(() => deleteFolderWithPhotos(db, 999_999)).toThrowError(FolderNotFoundError)
    // Nothing changed: folder live, photo still in it, only the assign action exists.
    expect(listFolders(db, batch.id).map((f) => f.id)).toContain(folder.id)
    expect(photoState(db, photoId)).toEqual({ status: 'folder', folder_id: folder.id })
    expect(actionCount(db)).toBe(1)

    expect(deleteFolderWithPhotos(db, folder.id)).toBe(1)
    expect(() => deleteFolderWithPhotos(db, folder.id)).toThrowError(FolderNotFoundError)
    // Failed repeat changed nothing: still one action group's worth of rows, photo stays in inbox.
    expect(actionCount(db)).toBe(2)
    expect(photoState(db, photoId)).toEqual({ status: 'inbox', folder_id: null })
  })

  it('restore fallback to a soft-deleted folder writes an explicit trash/folder → inbox/NULL audit row', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const folder = createFolder(db, batch.id, 'gone')
    const photoId = addPhoto(db, batch.id, 'E:/photos/a.jpg')
    assignToFolder(db, [photoId], folder.id)
    moveToTrash(db, [photoId])
    softDeleteFolder(db, folder.id)

    restoreFromTrash(db, [photoId])

    const restoreAction = listActions(db, batch.id).at(-1)!
    expect({
      from_status: restoreAction.from_status,
      from_folder_id: restoreAction.from_folder_id,
      to_status: restoreAction.to_status,
      to_folder_id: restoreAction.to_folder_id
    }).toEqual({
      from_status: 'trash',
      from_folder_id: folder.id,
      to_status: 'inbox',
      to_folder_id: null
    })
  })
})
