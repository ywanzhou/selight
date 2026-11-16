import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import BetterSqlite3, { type Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'

const dirs: string[] = []
const handles: Database[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-db-'))
  dirs.push(dir)
  return dir
}

function open(file: string) {
  const result = openDatabase(file)
  handles.push(result.db)
  return result
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

const EXPECTED_TABLES = ['batches', 'sources', 'folders', 'photos', 'actions']

function tableNames(db: Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name).sort()
}

describe('openDatabase schema', () => {
  it('creates all five tables', () => {
    const file = path.join(tempDir(), 'selight.db')
    const { db } = open(file)
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES].sort())
  })

  it('returns recovered=false on the normal path', () => {
    const file = path.join(tempDir(), 'selight.db')
    expect(open(file).recovered).toBe(false)
  })

  it('enables foreign keys, WAL and writes user_version', () => {
    const file = path.join(tempDir(), 'selight.db')
    const { db } = open(file)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(db.pragma('user_version', { simple: true })).toBe(2)
  })

  it('defines UNIQUE(batch_id, abs_path) indexes on photos and sources', () => {
    const file = path.join(tempDir(), 'selight.db')
    const { db } = open(file)
    for (const index of ['idx_sources_batch_path', 'idx_photos_batch_path']) {
      const row = db
        .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
        .get(index) as { sql: string }
      expect(row.sql).toMatch(/UNIQUE/i)
      expect(row.sql).toContain('(batch_id, abs_path)')
    }
  })

  it('defines a partial unique index on folders(batch_id, name) for live rows', () => {
    const file = path.join(tempDir(), 'selight.db')
    const { db } = open(file)
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='idx_folders_batch_name'")
      .get() as { sql: string }
    expect(row.sql).toMatch(/UNIQUE/i)
    expect(row.sql).toContain('(batch_id, name)')
    expect(row.sql).toContain('WHERE deleted_at IS NULL')

    db.prepare('INSERT INTO batches (id, name) VALUES (1, ?)').run('b1')
    db.prepare('INSERT INTO folders (id, batch_id, name, sort_order) VALUES (1, 1, ?, 0)').run(
      '合影'
    )
    expect(() =>
      db.prepare('INSERT INTO folders (id, batch_id, name, sort_order) VALUES (2, 1, ?, 1)').run(
        '合影'
      )
    ).toThrow()
    db.prepare('UPDATE folders SET deleted_at = ? WHERE id = 1').run(1700000000000)
    db.prepare('INSERT INTO folders (id, batch_id, name, sort_order) VALUES (3, 1, ?, 2)').run(
      '合影'
    )
  })

  it('defaults photos.orientation to 1, missing to 0 and actions.undone to 0', () => {
    const file = path.join(tempDir(), 'selight.db')
    const { db } = open(file)
    const column = (table: string, name: string) =>
      (db.pragma(`table_info(${table})`) as Array<{ name: string; dflt_value: unknown }>).find(
        (c) => c.name === name
      )!
    expect(String(column('photos', 'orientation').dflt_value)).toBe('1')
    expect(String(column('photos', 'missing').dflt_value)).toBe('0')
    expect(String(column('actions', 'undone').dflt_value)).toBe('0')
  })

  it('stores all timestamps as INTEGER epoch millis, including expression defaults', () => {
    const file = path.join(tempDir(), 'selight.db')
    const { db } = open(file)
    const timestampColumns: Array<[string, string, boolean]> = [
      ['batches', 'created_at', true],
      ['batches', 'last_opened_at', false],
      ['sources', 'imported_at', true],
      ['sources', 'last_scan_at', false],
      ['folders', 'created_at', true],
      ['folders', 'deleted_at', false],
      ['photos', 'created_at', true],
      ['photos', 'updated_at', true],
      ['photos', 'mtime', false],
      ['actions', 'created_at', true]
    ]
    for (const [table, name, hasDefault] of timestampColumns) {
      const info = (
        db.pragma(`table_info(${table})`) as Array<{
          name: string
          type: string
          dflt_value: string | null
        }>
      ).find((c) => c.name === name)!
      expect(info.type.toUpperCase()).toBe('INTEGER')
      if (hasDefault) expect(info.dflt_value).toContain("strftime('%s','now')")
    }

    const before = Date.now()
    db.prepare('INSERT INTO batches (id, name) VALUES (1, ?)').run('b1')
    db.prepare('INSERT INTO sources (id, batch_id, abs_path) VALUES (1, 1, ?)').run('s')
    db.prepare(
      `INSERT INTO photos (id, batch_id, source_id, abs_path, filename, ext,
        size_bytes, mtime, status) VALUES (1, 1, 1, ?, ?, ?, ?, ?, 'inbox')`
    ).run('p/a.jpg', 'a.jpg', '.jpg', 1024, 1700000000000)
    db.prepare(
      `INSERT INTO actions (id, batch_id, batch_id_group, photo_id, to_status)
       VALUES (1, 1, 1, 1, 'trash')`
    ).run()
    const after = Date.now()

    const batch = db.prepare('SELECT created_at FROM batches').get() as { created_at: number }
    expect(Number.isInteger(batch.created_at)).toBe(true)
    expect(batch.created_at).toBeGreaterThan(1e12)
    // The expression default truncates to whole seconds, so allow a one-second window.
    expect(batch.created_at).toBeGreaterThanOrEqual(before - 1000)
    expect(batch.created_at).toBeLessThanOrEqual(after + 1000)

    const photo = db.prepare('SELECT mtime, created_at, updated_at FROM photos').get() as Record<
      string,
      number
    >
    for (const value of Object.values(photo)) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThan(1e12)
    }
    const action = db.prepare('SELECT created_at FROM actions').get() as { created_at: number }
    expect(Number.isInteger(action.created_at)).toBe(true)
  })

  it('enforces foreign keys', () => {
    const file = path.join(tempDir(), 'selight.db')
    const { db } = open(file)
    expect(() =>
      db.prepare('INSERT INTO sources (batch_id, abs_path) VALUES (999, ?)').run('x')
    ).toThrow()
  })

  it('reopens the same file without error and keeps existing data', () => {
    const file = path.join(tempDir(), 'selight.db')
    const first = open(file)
    first.db.prepare('INSERT INTO batches (name) VALUES (?)').run('婚礼 A')
    first.db.close()
    handles.splice(handles.indexOf(first.db), 1)

    const second = open(file)
    expect(second.recovered).toBe(false)
    const row = second.db.prepare('SELECT name FROM batches').get() as { name: string }
    expect(row.name).toBe('婚礼 A')
  })

  it('migrates a v1 database to v2: actions rebuilt with nullable photo_id, old rows kept', () => {
    const file = path.join(tempDir(), 'selight.db')
    // Hand-built v1 database: actions.photo_id is NOT NULL as shipped in schema v1.
    const legacy = new BetterSqlite3(file)
    legacy.exec(`
      CREATE TABLE batches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_opened_at INTEGER);
      CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL,
        abs_path TEXT NOT NULL, imported_at INTEGER NOT NULL, last_scan_at INTEGER);
      CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL,
        name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE photos (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL,
        source_id INTEGER NOT NULL, abs_path TEXT NOT NULL, filename TEXT NOT NULL,
        ext TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime INTEGER NOT NULL,
        width INTEGER, height INTEGER, orientation INTEGER NOT NULL DEFAULT 1,
        thumb_path TEXT, preview_path TEXT, status TEXT NOT NULL, folder_id INTEGER,
        missing INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE TABLE actions (id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        batch_id_group INTEGER NOT NULL,
        photo_id INTEGER NOT NULL REFERENCES photos(id),
        from_status TEXT,
        from_folder_id INTEGER REFERENCES folders(id),
        to_status TEXT NOT NULL,
        to_folder_id INTEGER REFERENCES folders(id),
        undone INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      PRAGMA user_version = 1;
      INSERT INTO batches (id, name, created_at) VALUES (1, 'b', 1700000000000);
      INSERT INTO photos (id, batch_id, source_id, abs_path, filename, ext,
        size_bytes, mtime, status, created_at, updated_at)
      VALUES (1, 1, 1, 'p/a.jpg', 'a.jpg', '.jpg', 1024, 1700000000000,
        'inbox', 1700000000000, 1700000000000);
      INSERT INTO actions (batch_id, batch_id_group, photo_id, from_status, to_status, created_at)
      VALUES (1, 1, 1, 'inbox', 'folder', 1700000000000);
    `)
    legacy.close()

    const { db, recovered } = open(file)
    expect(recovered).toBe(false)
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    expect(tableNames(db)).toContain('actions')

    // Existing action rows survive with their data intact.
    const oldRows = db
      .prepare('SELECT photo_id, from_status, to_status, undone FROM actions')
      .all()
    expect(oldRows).toEqual([
      { photo_id: 1, from_status: 'inbox', to_status: 'folder', undone: 0 }
    ])
    // v2 allows the NULL-photo marker row; v1's NOT NULL constraint would have rejected it.
    expect(() =>
      db
        .prepare(
          `INSERT INTO actions (batch_id, batch_id_group, photo_id, from_status, to_status)
           VALUES (1, 2, NULL, 'folder', 'inbox')`
        )
        .run()
    ).not.toThrow()
    expect((db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number }).n).toBe(2)
    // Non-actions data is untouched.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n
    ).toBe(1)
  })

  it('recovers a corrupt database: backs it up as .corrupt-<ts> and rebuilds an empty one', () => {
    const dir = tempDir()
    const file = path.join(dir, 'selight.db')
    fs.writeFileSync(file, Buffer.from('this is not a sqlite database', 'utf8'))

    const { db, recovered } = open(file)
    expect(recovered).toBe(true)
    expect(fs.readdirSync(dir).some((n) => n.startsWith('selight.db.corrupt-'))).toBe(true)
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES].sort())
    expect((db.prepare('SELECT COUNT(*) AS n FROM batches').get() as { n: number }).n).toBe(0)
    db.close()
    handles.splice(handles.indexOf(db), 1)

    const reopened = open(file)
    expect(reopened.recovered).toBe(false)
  })
})
