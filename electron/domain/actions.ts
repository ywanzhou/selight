import type { Database } from 'better-sqlite3'
import type { PhotoStatus } from './photos'

interface UndoActionRow {
  // NULL for folder-deletion marker rows: they drive folder revival but update no photo.
  photo_id: number | null
  from_status: PhotoStatus
  from_folder_id: number | null
}

interface FolderState {
  id: number
  name: string
  sort_order: number
  deleted_at: number | null
}

// Ruling 11: revive a soft-deleted folder under its exact name when free, otherwise under
// "原名 (恢复 N)" with the smallest N not used by a live folder. sort_order is never mutated
// while a folder is deleted, so clearing deleted_at restores its original sort_order.
function reviveFolder(db: Database, folder: FolderState, liveNames: Set<string>): void {
  let name = folder.name
  if (liveNames.has(name)) {
    let n = 1
    do {
      name = `${folder.name} (恢复 ${n})`
      n += 1
    } while (liveNames.has(name))
  }
  db.prepare('UPDATE folders SET deleted_at = NULL, name = ? WHERE id = ?').run(
    name,
    folder.id
  )
  liveNames.add(name)
}

// Reverts the most recent non-undone action group of one batch, atomically.
// Returns false when every group in the batch is already undone (or none exists).
export function undoLastGroup(db: Database, batchId: number): boolean {
  const group = db
    .prepare(
      'SELECT MAX(batch_id_group) AS g FROM actions WHERE batch_id = ? AND undone = 0'
    )
    .get(batchId) as { g: number | null }
  if (group.g === null) return false
  const groupId = group.g

  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT photo_id, from_status, from_folder_id
         FROM actions WHERE batch_id = ? AND batch_id_group = ?`
      )
      .all(batchId, groupId) as UndoActionRow[]

    // Only folders the restored photos return to must be live; trashed/inbox states need none.
    const neededFolderIds = [
      ...new Set(
        rows.filter((row) => row.from_status === 'folder').map((row) => row.from_folder_id)
      )
    ].filter((id): id is number => id !== null)

    if (neededFolderIds.length > 0) {
      // shortcut: one placeholder per id; a single group realistically touches a handful of folders.
      const folders = db
        .prepare(
          `SELECT id, name, sort_order, deleted_at FROM folders
           WHERE id IN (${neededFolderIds.map(() => '?').join(', ')})`
        )
        .all(...neededFolderIds) as FolderState[]
      const liveNames = new Set(
        (
          db
            .prepare(
              'SELECT name FROM folders WHERE batch_id = ? AND deleted_at IS NULL'
            )
            .all(batchId) as { name: string }[]
        ).map((row) => row.name)
      )
      for (const folder of folders) {
        if (folder.deleted_at !== null) reviveFolder(db, folder, liveNames)
      }
    }

    const now = Date.now()
    const restorePhoto = db.prepare(
      'UPDATE photos SET status = ?, folder_id = ?, updated_at = ? WHERE id = ?'
    )
    for (const row of rows) {
      if (row.photo_id === null) continue
      restorePhoto.run(row.from_status, row.from_folder_id, now, row.photo_id)
    }

    db.prepare(
      'UPDATE actions SET undone = 1 WHERE batch_id = ? AND batch_id_group = ?'
    ).run(batchId, groupId)
    return true
  })()
}
