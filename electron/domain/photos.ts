import type { Database } from 'better-sqlite3'

export type PhotoStatus = 'inbox' | 'folder' | 'trash'

export type View =
  | { kind: 'inbox' }
  | { kind: 'folder'; folderId: number }
  | { kind: 'trash' }

export interface PhotoInput {
  batchId: number
  sourceId: number
  absPath: string
  filename: string
  ext: string
  sizeBytes: number
  mtime: number
  orientation: number
}

export interface PhotoRow extends PhotoInput {
  id: number
  width: number | null
  height: number | null
  thumbPath: string | null
  previewPath: string | null
  status: PhotoStatus
  folderId: number | null
  missing: number
  createdAt: number
  updatedAt: number
}

interface PhotoSnake {
  id: number
  batch_id: number
  source_id: number
  abs_path: string
  filename: string
  ext: string
  size_bytes: number
  mtime: number
  width: number | null
  height: number | null
  orientation: number
  thumb_path: string | null
  preview_path: string | null
  status: string
  folder_id: number | null
  missing: number
  created_at: number
  updated_at: number
}

const COLUMNS =
  'id, batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, width, height, orientation, thumb_path, preview_path, status, folder_id, missing, created_at, updated_at'

function mapRow(row: PhotoSnake): PhotoRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceId: row.source_id,
    absPath: row.abs_path,
    filename: row.filename,
    ext: row.ext,
    sizeBytes: row.size_bytes,
    mtime: row.mtime,
    width: row.width,
    height: row.height,
    orientation: row.orientation,
    thumbPath: row.thumb_path,
    previewPath: row.preview_path,
    status: row.status as PhotoStatus,
    folderId: row.folder_id,
    missing: row.missing,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function getPhoto(db: Database, id: number): PhotoRow {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ?`)
    .get(id) as PhotoSnake
  return mapRow(row)
}

export function upsertPhoto(
  db: Database,
  input: PhotoInput
): { row: PhotoRow; created: boolean } {
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM photos WHERE batch_id = ? AND abs_path = ?')
      .get(input.batchId, input.absPath) as { id: number } | undefined

    const info = db
      .prepare(
        `INSERT INTO photos
           (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, orientation, status)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, 'inbox')
         ON CONFLICT(batch_id, abs_path) DO UPDATE SET
           source_id = excluded.source_id,
           filename = excluded.filename,
           ext = excluded.ext,
           size_bytes = excluded.size_bytes,
           mtime = excluded.mtime,
           orientation = excluded.orientation,
           updated_at = ?
         WHERE photos.mtime IS NOT excluded.mtime
            OR photos.size_bytes IS NOT excluded.size_bytes`
      )
      .run(
        input.batchId,
        input.sourceId,
        input.absPath,
        input.filename,
        input.ext,
        input.sizeBytes,
        input.mtime,
        input.orientation,
        Date.now()
      )

    // On conflict last_insert_rowid is unreliable: a skipped WHERE leaves it untouched and an
    // applied UPDATE may still return a rowid from an earlier INSERT on this connection.
    // Reuse the row looked up above; lastInsertRowid is only valid for the fresh-INSERT branch.
    const id = existing ? existing.id : Number(info.lastInsertRowid)
    return { row: getPhoto(db, id), created: !existing }
  })()
}

export function listPhotos(db: Database, batchId: number, view: View): PhotoRow[] {
  let where = 'batch_id = ?'
  const params: unknown[] = [batchId]
  if (view.kind === 'folder') {
    where += ' AND status = ? AND folder_id = ?'
    params.push('folder', view.folderId)
  } else {
    // view.kind is 'inbox' or 'trash', which are also the stored status values.
    where += ' AND status = ?'
    params.push(view.kind)
  }

  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM photos WHERE ${where} ORDER BY abs_path`)
    .all(...params) as PhotoSnake[]
  return rows.map(mapRow)
}

export function counts(
  db: Database,
  batchId: number
): { total: number; inbox: number; folder: number; trash: number } {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(status = 'inbox'), 0) AS inbox,
         COALESCE(SUM(status = 'folder'), 0) AS folder,
         COALESCE(SUM(status = 'trash'), 0) AS trash
       FROM photos WHERE batch_id = ?`
    )
    .get(batchId) as { total: number; inbox: number; folder: number; trash: number }
}

export function markMissing(
  db: Database,
  batchId: number,
  existingPaths: Set<string>
): number {
  const paths = [...existingPaths]
  // shortcut: one bound variable per path (SQLite limit 32766); chunk the UPDATE if a batch ever exceeds ~32k photos.
  const sql =
    paths.length === 0
      ? 'UPDATE photos SET missing = 1 WHERE batch_id = ? AND missing = 0'
      : `UPDATE photos SET missing = 1
         WHERE batch_id = ? AND missing = 0
           AND abs_path NOT IN (${paths.map(() => '?').join(', ')})`
  return db.prepare(sql).run(batchId, ...paths).changes
}
