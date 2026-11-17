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
}

export interface PhotoRow extends PhotoInput {
  id: number
  // Orientation stays a DB column but is no longer part of the discovery input:
  // it is written by the enrichment pass and read back here.
  orientation: number
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
           (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, status)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, 'inbox')
         ON CONFLICT(batch_id, abs_path) DO UPDATE SET
           source_id = excluded.source_id,
           filename = excluded.filename,
           ext = excluded.ext,
           size_bytes = excluded.size_bytes,
           mtime = excluded.mtime,
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

// The single "not yet enriched" marker: width IS NULL means no enrichment pass
// has ever succeeded for the row (orientation has a DEFAULT 1 and cannot tell
// "unread" from "genuinely 1"). Both the open-batch catch-up and the thumbnail
// worker's RAW self-heal select through this query.
export function findUnenrichedPhotoIds(db: Database, batchId: number): number[] {
  const rows = db
    .prepare('SELECT id FROM photos WHERE batch_id = ? AND width IS NULL ORDER BY id')
    .all(batchId) as { id: number }[]
  return rows.map((row) => row.id)
}

// Backfill candidates: enriched rows whose thumbnail may still be missing.
// fs-level existence is checked by the caller; this stays a pure SQL selector.
// offset lets the backfill scheduler page past rows already inspected so a
// fixed limit cannot trap it on the first id window forever.
export function findEnrichedPhotoIds(
  db: Database,
  limit: number,
  offset = 0
): number[] {
  const rows = db
    .prepare(
      'SELECT id FROM photos WHERE width IS NOT NULL ORDER BY id LIMIT ? OFFSET ?'
    )
    .all(limit, offset) as { id: number }[]
  return rows.map((row) => row.id)
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

// Bound-variable safety margin below SQLite's 32766 limit, matching the present-path
// reset chunking in scanner.ts.
const MARK_MISSING_CHUNK = 500

export function markMissing(
  db: Database,
  batchId: number,
  existingPaths: Set<string>,
  sourceId?: number
): number {
  // NOT IN cannot be split across statements: a present row whose path sits in another
  // chunk would satisfy "NOT IN this chunk" and get wrongly flagged. Membership is
  // therefore tested against the JS set, and only the id UPDATE is chunked (Ruling: 500).
  // A sourceId scopes the work to one source: a batch can hold several imported roots,
  // and rescanning one root must never flag rows belonging to the other roots.
  const rows = db
    .prepare(
      `SELECT id, abs_path FROM photos
       WHERE batch_id = ? AND missing = 0
         ${sourceId === undefined ? '' : 'AND source_id = ?'}`
    )
    .all(
      ...(sourceId === undefined ? [batchId] : [batchId, sourceId])
    ) as { id: number; abs_path: string }[]
  const absentIds = rows.filter((row) => !existingPaths.has(row.abs_path)).map((row) => row.id)

  let changed = 0
  for (let i = 0; i < absentIds.length; i += MARK_MISSING_CHUNK) {
    const slice = absentIds.slice(i, i + MARK_MISSING_CHUNK)
    changed += db
      .prepare(
        `UPDATE photos SET missing = 1 WHERE id IN (${slice.map(() => '?').join(', ')})`
      )
      .run(...slice).changes
  }
  return changed
}
