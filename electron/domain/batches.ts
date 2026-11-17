import type { Database } from 'better-sqlite3'

export interface BatchRow {
  id: number
  name: string
  createdAt: number
  lastOpenedAt: number
}

interface BatchSnake {
  id: number
  name: string
  created_at: number
  last_opened_at: number | null
}

const COLUMNS = 'id, name, created_at, last_opened_at'

function mapRow(row: BatchSnake): BatchRow {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    // Domain writes always set last_opened_at; fall back for rows inserted outside the domain.
    lastOpenedAt: row.last_opened_at ?? row.created_at
  }
}

function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function createBatch(db: Database, name?: string): BatchRow {
  const info = db
    .prepare('INSERT INTO batches (name, last_opened_at) VALUES (?, ?)')
    .run(name ?? localDate(), Date.now())
  return getBatch(db, Number(info.lastInsertRowid))!
}

export function listBatches(db: Database): BatchRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM batches ORDER BY last_opened_at DESC`)
    .all() as BatchSnake[]
  return rows.map(mapRow)
}

export function touchBatch(db: Database, id: number): void {
  db.prepare('UPDATE batches SET last_opened_at = ? WHERE id = ?').run(Date.now(), id)
}

// Batch names carry no uniqueness constraint (date defaults legitimately repeat),
// so there is no conflict check; last_opened_at is untouched to keep the dropdown
// order stable while editing a name.
export function renameBatch(db: Database, id: number, name: string): void {
  db.transaction(() => {
    const batch = db.prepare('SELECT id FROM batches WHERE id = ?').get(id)
    if (batch === undefined) throw new BatchNotFoundError(id)
    db.prepare('UPDATE batches SET name = ? WHERE id = ?').run(name, id)
  })()
}

export function getBatch(db: Database, id: number): BatchRow | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM batches WHERE id = ?`)
    .get(id) as BatchSnake | undefined
  return row ? mapRow(row) : undefined
}

export class BatchNotFoundError extends Error {
  constructor(batchId: number) {
    super(`batch not found: ${batchId}`)
    this.name = 'BatchNotFoundError'
  }
}

/**
 * Hard-delete a batch and every row it owns, in FK dependency order:
 * actions → photos → folders → sources → the batch itself. Originals on disk
 * are never touched. Returns the removed photo ids so the IPC layer can clean
 * their thumbnail/preview cache files. All-or-nothing in one transaction.
 */
export function deleteBatch(db: Database, batchId: number): number[] {
  return db.transaction(() => {
    const batch = db.prepare('SELECT id FROM batches WHERE id = ?').get(batchId)
    if (batch === undefined) throw new BatchNotFoundError(batchId)

    const photoIds = (
      db.prepare('SELECT id FROM photos WHERE batch_id = ?').all(batchId) as {
        id: number
      }[]
    ).map((row) => row.id)

    // actions reference photos, folders and the batch, so they must go first.
    db.prepare('DELETE FROM actions WHERE batch_id = ?').run(batchId)
    // photos reference sources and folders; both are deleted only afterwards.
    db.prepare('DELETE FROM photos WHERE batch_id = ?').run(batchId)
    db.prepare('DELETE FROM folders WHERE batch_id = ?').run(batchId)
    db.prepare('DELETE FROM sources WHERE batch_id = ?').run(batchId)
    db.prepare('DELETE FROM batches WHERE id = ?').run(batchId)
    return photoIds
  })()
}
