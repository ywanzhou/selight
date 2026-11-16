import type { Database } from 'better-sqlite3'

export interface FolderRow {
  id: number
  batchId: number
  name: string
  sortOrder: number
  createdAt: number
  deletedAt: number | null
}

interface FolderSnake {
  id: number
  batch_id: number
  name: string
  sort_order: number
  created_at: number
  deleted_at: number | null
}

const COLUMNS = 'id, batch_id, name, sort_order, created_at, deleted_at'

export class FolderNameConflictError extends Error {
  constructor(name: string) {
    super(`folder name already exists in this batch: ${name}`)
    this.name = 'FolderNameConflictError'
  }
}

function mapRow(row: FolderSnake): FolderRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    deletedAt: row.deleted_at
  }
}

function getFolder(db: Database, id: number): FolderRow {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM folders WHERE id = ?`)
    .get(id) as FolderSnake
  return mapRow(row)
}

export function createFolder(db: Database, batchId: number, name: string): FolderRow {
  const insert = db.transaction((): number => {
    const conflict = db
      .prepare(
        'SELECT 1 FROM folders WHERE batch_id = ? AND name = ? AND deleted_at IS NULL'
      )
      .get(batchId, name)
    if (conflict) throw new FolderNameConflictError(name)

    const max = db
      .prepare(
        'SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM folders WHERE batch_id = ? AND deleted_at IS NULL'
      )
      .get(batchId) as { max_sort: number }

    const info = db
      .prepare('INSERT INTO folders (batch_id, name, sort_order) VALUES (?, ?, ?)')
      .run(batchId, name, max.max_sort + 1)
    return Number(info.lastInsertRowid)
  })

  return getFolder(db, insert())
}

export function renameFolder(db: Database, id: number, name: string): void {
  db.transaction(() => {
    const conflict = db
      .prepare(
        'SELECT 1 FROM folders WHERE batch_id = (SELECT batch_id FROM folders WHERE id = ?) AND name = ? AND deleted_at IS NULL AND id != ?'
      )
      .get(id, name, id)
    if (conflict) throw new FolderNameConflictError(name)

    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id)
  })()
}

export function softDeleteFolder(db: Database, id: number): void {
  db.prepare('UPDATE folders SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
}

export function listFolders(db: Database, batchId: number): FolderRow[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM folders WHERE batch_id = ? AND deleted_at IS NULL ORDER BY sort_order`
    )
    .all(batchId) as FolderSnake[]
  return rows.map(mapRow)
}
