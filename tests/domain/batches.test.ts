import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch, getBatch, listBatches, touchBatch } from '../../electron/domain/batches'

const dirs: string[] = []
const handles: Database[] = []

function tempDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-batches-'))
  dirs.push(dir)
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)
  return db
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

function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Spin until the epoch-millisecond clock advances, so ordering assertions stay deterministic.
function nextTick(): void {
  const t = Date.now()
  while (Date.now() === t) {
    /* busy wait */
  }
}

describe('batch domain module', () => {
  it('createBatch defaults the name to the local YYYY-MM-DD date and sets lastOpenedAt', () => {
    const db = tempDb()
    const before = Date.now()
    const batch = createBatch(db)
    const after = Date.now()

    expect(batch.name).toBe(localDate())
    expect(batch.id).toBeGreaterThan(0)
    expect(Number.isInteger(batch.createdAt)).toBe(true)
    expect(Number.isInteger(batch.lastOpenedAt)).toBe(true)
    expect(batch.lastOpenedAt).toBeGreaterThanOrEqual(before)
    expect(batch.lastOpenedAt).toBeLessThanOrEqual(after)
  })

  it('createBatch uses an explicit name when given', () => {
    const db = tempDb()
    const batch = createBatch(db, '婚礼 A')
    expect(batch.name).toBe('婚礼 A')
    expect(getBatch(db, batch.id)?.name).toBe('婚礼 A')
  })

  it('lists batches with the most recently opened first', () => {
    const db = tempDb()
    const first = createBatch(db, 'first')
    nextTick()
    const second = createBatch(db, 'second')

    const rows = listBatches(db)
    expect(rows.map((b) => b.id)).toEqual([second.id, first.id])
    expect(rows[0]).toEqual(second)
  })

  it('returns an empty list when no batches exist', () => {
    expect(listBatches(tempDb())).toEqual([])
  })

  it('touchBatch updates lastOpenedAt without touching createdAt', () => {
    const db = tempDb()
    const batch = createBatch(db)
    nextTick()
    touchBatch(db, batch.id)

    const updated = getBatch(db, batch.id)!
    expect(updated.lastOpenedAt).toBeGreaterThan(batch.lastOpenedAt)
    expect(updated.createdAt).toBe(batch.createdAt)
    expect(updated.name).toBe(batch.name)
  })

  it('getBatch returns undefined for an unknown id', () => {
    const db = tempDb()
    expect(getBatch(db, 9999)).toBeUndefined()
  })
})
