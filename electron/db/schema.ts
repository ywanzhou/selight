import BetterSqlite3, { type Database } from 'better-sqlite3'
import fs from 'node:fs'

export const SCHEMA_VERSION = 2

// Epoch milliseconds; parenthesized expression defaults need SQLite 3.31+ (bundled in better-sqlite3 13).
const NOW_EPOCH_MS = `(CAST(strftime('%s','now') AS INTEGER) * 1000)`

// v2: photo_id is nullable so folder deletions with no folder-status photos can log a
// NULL-photo marker row that keeps the deletion itself undoable.
const ACTIONS_DDL = `CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  batch_id_group INTEGER NOT NULL,
  photo_id INTEGER REFERENCES photos(id),
  from_status TEXT,
  from_folder_id INTEGER REFERENCES folders(id),
  to_status TEXT NOT NULL,
  to_folder_id INTEGER REFERENCES folders(id),
  undone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${NOW_EPOCH_MS}
);`

const DDL = `
CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${NOW_EPOCH_MS},
  last_opened_at INTEGER
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  abs_path TEXT NOT NULL,
  imported_at INTEGER NOT NULL DEFAULT ${NOW_EPOCH_MS},
  last_scan_at INTEGER
);
CREATE UNIQUE INDEX idx_sources_batch_path ON sources(batch_id, abs_path);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${NOW_EPOCH_MS},
  deleted_at INTEGER
);
CREATE UNIQUE INDEX idx_folders_batch_name
  ON folders(batch_id, name) WHERE deleted_at IS NULL;

CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  abs_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  orientation INTEGER NOT NULL DEFAULT 1,
  thumb_path TEXT,
  preview_path TEXT,
  status TEXT NOT NULL,
  folder_id INTEGER REFERENCES folders(id),
  missing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${NOW_EPOCH_MS},
  updated_at INTEGER NOT NULL DEFAULT ${NOW_EPOCH_MS}
);
CREATE UNIQUE INDEX idx_photos_batch_path ON photos(batch_id, abs_path);

${ACTIONS_DDL}
`

export interface OpenDatabaseResult {
  db: Database
  /** true when the existing file was corrupt, backed up and rebuilt empty */
  recovered: boolean
}

function migrate(db: Database): void {
  const current = Number(db.pragma('user_version', { simple: true }))
  if (current >= SCHEMA_VERSION) return
  if (current === 0) {
    db.exec('BEGIN;\n' + DDL + '\nCOMMIT;')
  } else if (current === 1) {
    // v1→v2: app is unreleased; only actions is rebuilt to make photo_id nullable for
    // folder-deletion marker rows. Existing rows all have non-null photo_id and are copied
    // verbatim, while photos/folders data is untouched. actions has no indexes to rebuild.
    db.exec(`BEGIN;
      ${ACTIONS_DDL.replace('CREATE TABLE actions', 'CREATE TABLE actions_new')}
      INSERT INTO actions_new
        (id, batch_id, batch_id_group, photo_id, from_status, from_folder_id,
         to_status, to_folder_id, undone, created_at)
      SELECT id, batch_id, batch_id_group, photo_id, from_status, from_folder_id,
             to_status, to_folder_id, undone, created_at
      FROM actions;
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
      COMMIT;`)
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

function init(db: Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  migrate(db)
}

export function openDatabase(file: string): OpenDatabaseResult {
  let db: Database | undefined
  try {
    db = new BetterSqlite3(file)
    init(db)
    return { db, recovered: false }
  } catch (err) {
    if (!(err instanceof BetterSqlite3.SqliteError)) throw err
    db?.close()

    const backup = `${file}.corrupt-${Date.now()}`
    if (fs.existsSync(file)) fs.copyFileSync(file, backup)
    // The corrupt bytes must leave the path before a fresh database is created there.
    fs.rmSync(file, { force: true })
    // Stale WAL/SHM sidecars would re-corrupt the replacement file.
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      fs.rmSync(sidecar, { force: true })
    }

    const fresh = new BetterSqlite3(file)
    init(fresh)
    return { db: fresh, recovered: true }
  }
}
