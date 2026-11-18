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

export class FolderNameInvalidError extends Error {
  constructor(name: string, reason: string) {
    super(`invalid folder name "${name}": ${reason}`)
    this.name = 'FolderNameInvalidError'
  }
}

// Windows device names that cannot name a filesystem entry, case-insensitive,
// including the "<name>.<ext>" form (CON.txt still resolves to the device).
// Scope follows the backlog spec (COM/LPT 1-9); COM0/LPT0 and higher numbers
// plus ASCII control chars are not enumerated here — the export mkdir guard
// still contains those failures as defense in depth.
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
])
const FORBIDDEN_CHARS = /[?*|<>"\/\\]/

/**
 * Domain folder-name rule. Returns null when the name is usable, otherwise an
 * English reason string; callers map it to localized UI text. Trims whitespace
 * so the stored name and the validation see the same value. Trailing dots or
 * spaces are rejected: Win32 strips them when creating directories, so two
 * distinct stored names would silently merge on export.
 */
export function validateFolderName(rawName: string): string | null {
  // Check the untrimmed input: Win32 strips trailing dots/spaces at the
  // filesystem boundary, so after trim they would be invisible and two
  // distinct rows could merge into one export directory.
  if (/[.\s]$/.test(rawName)) {
    return 'folder name must not end with a dot or space'
  }
  const name = rawName.trim()
  if (name === '') return 'folder name must not be empty'
  if (name === '.' || name === '..') return 'dot names are reserved'
  if (FORBIDDEN_CHARS.test(name)) {
    return 'folder name contains a forbidden character (? * | < > " / \\)'
  }
  const base = name.split('.')[0].toUpperCase()
  if (RESERVED_NAMES.has(base)) return 'reserved Windows device name'
  return null
}

function assertValidFolderName(rawName: string): string {
  const name = rawName.trim()
  const reason = validateFolderName(name)
  if (reason !== null) throw new FolderNameInvalidError(name, reason)
  return name
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

export function createFolder(db: Database, batchId: number, rawName: string): FolderRow {
  const insert = db.transaction((): number => {
    // Normalize once at the boundary so conflict checks and stored rows all
    // see the trimmed name; padded variants then correctly collide.
    const name = assertValidFolderName(rawName)
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

export function renameFolder(db: Database, id: number, rawName: string): void {
  db.transaction(() => {
    const name = assertValidFolderName(rawName)
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
