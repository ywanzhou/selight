import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
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
    expect(db.pragma('user_version', { simple: true })).toBe(1)
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
    db.prepare('UPDATE folders SET deleted_at = ? WHERE id = 1').run('2026-11-13T00:00:00Z')
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
