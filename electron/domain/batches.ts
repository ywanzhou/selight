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

export function getBatch(db: Database, id: number): BatchRow | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM batches WHERE id = ?`)
    .get(id) as BatchSnake | undefined
  return row ? mapRow(row) : undefined
}
