import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../electron/db/schema'
import { createBatch } from '../electron/domain/batches'
import { counts } from '../electron/domain/photos'
import {
  importScanned,
  scanDirectory,
  type ExifReader,
  type ScannedFile
} from '../electron/scanner'

const dirs: string[] = []
const handles: Database[] = []
const openFds: number[] = []

afterEach(() => {
  while (openFds.length) {
    try {
      fs.closeSync(openFds.pop()!)
    } catch {
      /* already closed */
    }
  }
  while (handles.length) {
    const db = handles.pop()!
    if (db.open) db.close()
  }
  while (dirs.length) {
    const dir = dirs.pop()!
    // Windows refuses to delete read-only files; restore writable bits before teardown.
    for (const f of walkFiles(dir)) fs.chmodSync(f, 0o666)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function tempDb(): Database {
  const dir = tempDir('selight-scan-db-')
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)
  return db
}

function writeFile(dir: string, name: string, contents = 'x'): string {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
  return p
}

// Fixture tree: nested dirs, direct + RAW formats, uppercase ext, ignored txt, empty dir.
function makeFixtureTree(): string {
  const root = tempDir('selight-scan-tree-')
  writeFile(root, 'a.jpg', 'jpeg-a')
  writeFile(root, 'b.JPG', 'jpeg-b')
  writeFile(root, 'note.txt', 'not a photo')
  writeFile(root, 'd.arw', 'raw-a')
  fs.mkdirSync(path.join(root, 'empty'))
  writeFile(root, 'sub/e.png', 'png')
  writeFile(root, 'sub/nested/f.webp', 'webp')
  writeFile(root, 'raw/g.CR2', 'raw-b')
  return root
}

const fixedReader: ExifReader = { readOrientation: async () => 6 }

function addSource(db: Database, batchId: number, absPath: string): number {
  const info = db
    .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
    .run(batchId, absPath)
  return Number(info.lastInsertRowid)
}

function byPath(files: ScannedFile[]): Map<string, ScannedFile> {
  return new Map(files.map((f) => [f.absPath, f]))
}

function missingFlag(db: Database, absPath: string): number {
  return (
    db.prepare('SELECT missing FROM photos WHERE abs_path = ?').get(absPath) as {
      missing: number
    }
  ).missing
}

describe('scanDirectory', () => {
  it('recursively finds supported photos, filters extensions, and lowercases ext', async () => {
    const root = makeFixtureTree()
    const { files, failures } = await scanDirectory(root, fixedReader)
    const map = byPath(files)
    expect(failures).toEqual([])

    expect(files).toHaveLength(6)
    expect([...map.keys()].sort()).toEqual(
      [
        'a.jpg',
        'b.JPG',
        'd.arw',
        path.join('raw', 'g.CR2'),
        path.join('sub', 'e.png'),
        path.join('sub', 'nested', 'f.webp')
      ]
          .map((rel) => path.join(root, rel))
          .sort()
    )

    // Uppercase extensions are normalized to lowercase; txt and empty dir produce nothing.
    expect(map.get(path.join(root, 'b.JPG'))?.ext).toBe('.jpg')
    expect(map.get(path.join(root, 'raw', 'g.CR2'))?.ext).toBe('.cr2')
    expect(files.every((f) => f.ext === f.ext.toLowerCase())).toBe(true)
    expect(map.has(path.join(root, 'note.txt'))).toBe(false)

    const a = map.get(path.join(root, 'a.jpg'))!
    expect(a.filename).toBe('a.jpg')
    expect(a.sizeBytes).toBe(Buffer.byteLength('jpeg-a'))
    expect(Number.isInteger(a.mtime)).toBe(true)
    expect(a.orientation).toBe(6)
  })

  it('falls back to orientation 1 when the reader fails, without aborting the scan', async () => {
    const root = makeFixtureTree()
    const failingReader: ExifReader = {
      readOrientation: async (absPath) => {
        if (absPath.endsWith('a.jpg')) throw new Error('exiftool boom')
        return 8
      }
    }

    const { files } = await scanDirectory(root, failingReader)
    const map = byPath(files)

    expect(files).toHaveLength(6)
    expect(map.get(path.join(root, 'a.jpg'))?.orientation).toBe(1)
    expect(map.get(path.join(root, 'b.JPG'))?.orientation).toBe(8)
  })

  it('returns no files and records the skipped path when the root dir is unreadable', async () => {
    const root = path.join(tempDir('selight-scan-missing-'), 'does-not-exist')
    const result = await scanDirectory(root, fixedReader)
    expect(result.files).toEqual([])
    expect(result.failures).toContain(root)
  })

  it('reads read-only fixtures while a source file stays open under a read-only flag', async () => {
    const root = makeFixtureTree()
    const all = walkFiles(root).filter((p) => path.extname(p).toLowerCase() !== '.txt')
    for (const p of all) fs.chmodSync(p, 0o444)
    // Holding an 'r' handle is fine; any write-mode open by the scanner would fail on Windows.
    openFds.push(fs.openSync(path.join(root, 'a.jpg'), 'r'))

    const { files } = await scanDirectory(root, fixedReader)
    expect(files).toHaveLength(6)
    expect(files.find((f) => f.filename === 'a.jpg')?.sizeBytes).toBe(
      Buffer.byteLength('jpeg-a')
    )
  })
})

describe('importScanned', () => {
  it('upserts scanned files, re-imports update instead of adding, and flags then clears missing', async () => {
    const root = makeFixtureTree()
    const db = tempDb()
    const batch = createBatch(db)
    const sourceId = addSource(db, batch.id, root)

    const first = importScanned(db, batch.id, sourceId, (await scanDirectory(root, fixedReader)).files)
    expect(first).toEqual({ added: 6, updated: 0, missing: 0 })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n
    ).toBe(6)

    const second = importScanned(db, batch.id, sourceId, (await scanDirectory(root, fixedReader)).files)
    expect(second).toEqual({ added: 0, updated: 6, missing: 0 })

    // Delete one fixture file: rescan no longer sees it, so the existing row goes missing.
    const gone = path.join(root, 'd.arw')
    fs.rmSync(gone)
    const third = importScanned(db, batch.id, sourceId, (await scanDirectory(root, fixedReader)).files)
    expect(third.added).toBe(0)
    expect(third.missing).toBe(1)
    expect(missingFlag(db, gone)).toBe(1)

    // Ruling 9: the file reappears; a mtime/size-identical upsert cannot clear missing itself,
    // so importScanned must reset the flag for paths present in the scan before markMissing.
    writeFile(root, 'd.arw', 'raw-a')
    const fourth = importScanned(db, batch.id, sourceId, (await scanDirectory(root, fixedReader)).files)
    expect(fourth).toEqual({ added: 0, updated: 6, missing: 0 })
    expect(missingFlag(db, gone)).toBe(0)
  })

  it('scopes missing marking/reset to the imported source in a multi-source batch', async () => {
    const rootA = tempDir('selight-scan-src-a-')
    const rootB = tempDir('selight-scan-src-b-')
    writeFile(rootA, 'a1.jpg')
    writeFile(rootA, 'sub/a2.jpg')
    writeFile(rootB, 'b1.jpg')
    writeFile(rootB, 'b2.jpg')

    const db = tempDb()
    const batch = createBatch(db)
    const sourceA = addSource(db, batch.id, rootA)
    const sourceB = addSource(db, batch.id, rootB)

    importScanned(
      db,
      batch.id,
      sourceA,
      (await scanDirectory(rootA, fixedReader)).files
    )
    importScanned(
      db,
      batch.id,
      sourceB,
      (await scanDirectory(rootB, fixedReader)).files
    )
    expect(counts(db, batch.id).total).toBe(4)

    // Re-import B after deleting b2: only B's deleted row may be flagged; source-A rows,
    // absent from B's scan by definition, must stay present.
    fs.rmSync(path.join(rootB, 'b2.jpg'))
    const reB = importScanned(
      db,
      batch.id,
      sourceB,
      (await scanDirectory(rootB, fixedReader)).files
    )
    expect(reB).toMatchObject({ added: 0, updated: 1, missing: 1 })
    expect(missingFlag(db, path.join(rootA, 'a1.jpg'))).toBe(0)
    expect(missingFlag(db, path.join(rootA, 'sub', 'a2.jpg'))).toBe(0)
    expect(missingFlag(db, path.join(rootB, 'b1.jpg'))).toBe(0)
    expect(missingFlag(db, path.join(rootB, 'b2.jpg'))).toBe(1)

    // Ruling 9 reset must be source-scoped too: a flagged A row clears on A re-import,
    // while B's missing flag survives an import that does not touch B.
    db.prepare('UPDATE photos SET missing = 1 WHERE abs_path = ?').run(
      path.join(rootA, 'a1.jpg')
    )
    const reA = importScanned(
      db,
      batch.id,
      sourceA,
      (await scanDirectory(rootA, fixedReader)).files
    )
    expect(reA.missing).toBe(0)
    expect(missingFlag(db, path.join(rootA, 'a1.jpg'))).toBe(0)
    expect(missingFlag(db, path.join(rootB, 'b2.jpg'))).toBe(1)

    // Rows are never deleted or reclassified: counts and inbox view stay intact.
    expect(counts(db, batch.id)).toMatchObject({ total: 4, inbox: 4 })
  })

  it('imports read-only fixtures without writing to the source files', async () => {
    const root = makeFixtureTree()
    for (const p of walkFiles(root)) fs.chmodSync(p, 0o444)
    const db = tempDb()
    const batch = createBatch(db)
    const sourceId = addSource(db, batch.id, root)

    const result = importScanned(db, batch.id, sourceId, (await scanDirectory(root, fixedReader)).files)
    expect(result.added).toBe(6)
    expect(result.missing).toBe(0)
  })
})
