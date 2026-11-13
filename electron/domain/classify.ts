import type { Database } from 'better-sqlite3'
import type { PhotoStatus } from './photos'

interface PhotoState {
  id: number
  batch_id: number
  status: PhotoStatus
  folder_id: number | null
}

interface Target {
  status: PhotoStatus
  folderId: number | null
}

function loadPhotos(db: Database, photoIds: number[]): PhotoState[] {
  // shortcut: one bound variable per id (SQLite limit 32766); chunk if a selection ever exceeds ~32k photos.
  return db
    .prepare(
      `SELECT id, batch_id, status, folder_id FROM photos
       WHERE id IN (${photoIds.map(() => '?').join(', ')})`
    )
    .all(...photoIds) as PhotoState[]
}

function nextGroupId(db: Database, batchId: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(batch_id_group), 0) + 1 AS next_group FROM actions WHERE batch_id = ?'
    )
    .get(batchId) as { next_group: number }
  return row.next_group
}

// One call = one transaction: reclassify every selected photo and append one action row per
// photo, all under a single new batch_id_group scoped to the photos' batch.
function applyActions(
  db: Database,
  photoIds: number[],
  resolveTarget: (photo: PhotoState) => Target
): number {
  if (photoIds.length === 0) return 0

  return db.transaction(() => {
    const photos = loadPhotos(db, photoIds)
    if (photos.length === 0) return 0

    const groupId = nextGroupId(db, photos[0].batch_id)
    const now = Date.now()
    const updatePhoto = db.prepare(
      'UPDATE photos SET status = ?, folder_id = ?, updated_at = ? WHERE id = ?'
    )
    const insertAction = db.prepare(
      `INSERT INTO actions
         (batch_id, batch_id_group, photo_id, from_status, from_folder_id, to_status, to_folder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )

    for (const photo of photos) {
      const target = resolveTarget(photo)
      updatePhoto.run(target.status, target.folderId, now, photo.id)
      insertAction.run(
        photo.batch_id,
        groupId,
        photo.id,
        photo.status,
        photo.folder_id,
        target.status,
        target.folderId
      )
    }
    return photos.length
  })()
}

export function assignToFolder(
  db: Database,
  photoIds: number[],
  folderId: number
): number {
  return applyActions(db, photoIds, () => ({ status: 'folder', folderId }))
}

export function moveToTrash(db: Database, photoIds: number[]): number {
  // Retain folder_id while trashed so restoreFromTrash can return the photo to its folder.
  return applyActions(db, photoIds, (photo) => ({
    status: 'trash',
    folderId: photo.folder_id
  }))
}

export function restoreFromTrash(db: Database, photoIds: number[]): number {
  const folderIsLive = db.prepare(
    'SELECT 1 FROM folders WHERE id = ? AND deleted_at IS NULL'
  )
  return applyActions(db, photoIds, (photo) => {
    if (photo.folder_id !== null && folderIsLive.get(photo.folder_id)) {
      return { status: 'folder', folderId: photo.folder_id }
    }
    return { status: 'inbox', folderId: null }
  })
}
