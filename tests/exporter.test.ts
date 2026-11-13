import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../electron/db/schema'
import { createBatch } from '../electron/domain/batches'
import { createFolder } from '../electron/domain/folders'
import { assignToFolder, moveToTrash } from '../electron/domain/classify'
import { listPhotos } from '../electron/domain/photos'
import { importScanned, scanDirectory, type ExifReader } from '../electron/scanner'
import { exportBatch, uniqueDestination } from '../electron/exporter'

// Real-fs suite: the exporter is electron-free (node:fs/path only) and must prove
// here that sources are never mutated and every write stays inside the output tree.

const dirs: string[] = []
const handles: Database[] = []

const fakeReader: ExifReader = { readOrientation: async () => 1 }

afterEach(() => {
  while (handles.length) {
    const db = handles.pop()!
    if (db.open) db.close()
  }
  while (dirs.length) {
    const dir = dirs.pop()!
    for (const f of walkFiles(dir)) {
      try {
        fs.chmodSync(f, 0o666)
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
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
  const dir = tempDir('selight-export-db-')
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)
  return db
}

function writeFile(dir: string, name: string, contents: string): string {
  const p = path.join(dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
  return p
}

interface Fixture {
  root: string
  /** Every photo in the tree, relative to root. */
  photos: string[]
}

// Two subdirs contain a same-named a.jpg: assigning both to one folder forces
// the collision-suffix path inside a single export run.
function makeFixtureTree(): Fixture {
  const root = tempDir('selight-export-src-')
  writeFile(root, 'a.jpg', 'jpeg-a')
  writeFile(root, 'b.png', 'png-b')
  writeFile(root, 'note.txt', 'ignored')
  writeFile(root, 'sub/a.jpg', 'jpeg-sub-a')
  writeFile(root, 'sub/c.webp', 'webp-c')
  writeFile(root, 'sub/nested/d.arw', 'raw-d')
  return {
    root,
    photos: ['a.jpg', 'b.png', path.join('sub', 'a.jpg'), path.join('sub', 'c.webp'), path.join('sub', 'nested', 'd.arw')]
  }
}

async function importFixture(db: Database, batchId: number, root: string): Promise<number[]> {
  const { files } = await scanDirectory(root, fakeReader)
  const info = db
    .prepare('INSERT INTO sources (batch_id, abs_path, last_scan_at) VALUES (?, ?, ?)')
    .run(batchId, root, Date.now())
  importScanned(db, batchId, Number(info.lastInsertRowid), files)
  return listPhotos(db, batchId, { kind: 'inbox' }).map((p) => p.id)
}

function snapshotTree(root: string): Map<string, string> {
  const snap = new Map<string, string>()
  for (const f of walkFiles(root)) {
    snap.set(path.relative(root, f), fs.readFileSync(f, 'utf8'))
  }
  return snap
}

function statSnapshot(root: string): Map<string, { size: number; mtimeMs: number }> {
  const snap = new Map<string, { size: number; mtimeMs: number }>()
  for (const f of walkFiles(root)) {
    const st = fs.statSync(f)
    snap.set(f, { size: st.size, mtimeMs: st.mtimeMs })
  }
  return snap
}

describe('exportBatch', () => {
  it('creates one same-named subdir per non-empty live folder, copies originals, and excludes trash', async () => {
    const db = tempDb()
    const batch = createBatch(db)
    const pick = createFolder(db, batch.id, '精选')
    const travel = createFolder(db, batch.id, '旅行')
    createFolder(db, batch.id, '空文件夹')
    const fixture = makeFixtureTree()
    const ids = await importFixture(db, batch.id, fixture.root)
    const inbox = listPhotos(db, batch.id, { kind: 'inbox' })
    const byName = new Map(inbox.map((p) => [p.filename + '|' + p.absPath, p.id]))
    const topA = byName.get('a.jpg|' + path.join(fixture.root, 'a.jpg'))!
    const subA = byName.get('a.jpg|' + path.join(fixture.root, 'sub', 'a.jpg'))!
    const b = byName.get('b.png|' + path.join(fixture.root, 'b.png'))!
    const c = byName.get('c.webp|' + path.join(fixture.root, 'sub', 'c.webp'))!
    const d = byName.get('d.arw|' + path.join(fixture.root, 'sub', 'nested', 'd.arw'))!
    expect(ids).toHaveLength(5)

    assignToFolder(db, [topA, subA, b], pick.id)
    assignToFolder(db, [c, d], travel.id)
    // Trashed after assignment: trash must never be exported, even though folder_id is retained.
    moveToTrash(db, [d])

    const output = tempDir('selight-export-out-')
    const progress: Array<[number, number]> = []
    const result = await exportBatch(db, batch.id, output, (done, total) =>
      progress.push([done, total])
    )

    expect(result.failures).toEqual([])
    // 3 in 精选 (two a.jpg + b.png), 1 in 旅行 (c.webp); d.arw is trashed.
    expect(result.copied).toBe(4)

    const entries = fs.readdirSync(output, { withFileTypes: true })
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    expect(subdirs).toEqual(['旅行', '精选'])
    expect(entries.some((e) => e.name === '空文件夹')).toBe(false)

    const pickFiles = fs.readdirSync(path.join(output, '精选')).sort()
    expect(pickFiles).toEqual(['a (1).jpg', 'a.jpg', 'b.png'])
    expect(fs.readFileSync(path.join(output, '精选', 'a.jpg'), 'utf8')).toBe('jpeg-a')
    expect(fs.readFileSync(path.join(output, '精选', 'a (1).jpg'), 'utf8')).toBe('jpeg-sub-a')
    expect(fs.readFileSync(path.join(output, '精选', 'b.png'), 'utf8')).toBe('png-b')

    const travelFiles = fs.readdirSync(path.join(output, '旅行'))
    expect(travelFiles).toEqual(['c.webp'])
    expect(fs.readFileSync(path.join(output, '旅行', 'c.webp'), 'utf8')).toBe('webp-c')

    // The trashed RAW is absent from the whole output tree.
    const exported = walkFiles(output).map((f) => path.basename(f))
    expect(exported).not.toContain('d.arw')

    // Progress is per settled file, ending exactly at done === total.
    expect(progress).toHaveLength(4)
    expect(progress.map(([, total]) => total)).toEqual([4, 4, 4, 4])
    expect(progress.map(([done]) => done)).toEqual([1, 2, 3, 4])
  })

  it('never overwrites a pre-existing destination: blocker file stays intact and the export gets a suffix', async () => {
    const db = tempDb()
    const batch = createBatch(db)
    const pick = createFolder(db, batch.id, '精选')
    const fixture = makeFixtureTree()
    await importFixture(db, batch.id, fixture.root)
    const topA = listPhotos(db, batch.id, { kind: 'inbox' }).find(
      (p) => p.absPath === path.join(fixture.root, 'a.jpg')
    )!
    assignToFolder(db, [topA.id], pick.id)

    const output = tempDir('selight-export-out-')
    fs.mkdirSync(path.join(output, '精选'))
    fs.writeFileSync(path.join(output, '精选', 'a.jpg'), 'pre-existing blocker')

    const result = await exportBatch(db, batch.id, output, () => undefined)

    expect(result.copied).toBe(1)
    expect(result.failures).toEqual([])
    expect(fs.readFileSync(path.join(output, '精选', 'a.jpg'), 'utf8')).toBe(
      'pre-existing blocker'
    )
    expect(fs.readFileSync(path.join(output, '精选', 'a (1).jpg'), 'utf8')).toBe('jpeg-a')
  })

  it('leaves every source file size and mtime unchanged and writes nothing outside the output tree', async () => {
    const db = tempDb()
    const batch = createBatch(db)
    const pick = createFolder(db, batch.id, '精选')
    const fixture = makeFixtureTree()
    await importFixture(db, batch.id, fixture.root)
    const inbox = listPhotos(db, batch.id, { kind: 'inbox' })
    assignToFolder(
      db,
      inbox.map((p) => p.id),
      pick.id
    )

    const beforeStats = statSnapshot(fixture.root)
    const beforeTree = snapshotTree(fixture.root)
    const output = tempDir('selight-export-out-')

    await exportBatch(db, batch.id, output, () => undefined)

    const afterStats = statSnapshot(fixture.root)
    expect(afterStats).toEqual(beforeStats)
    expect(snapshotTree(fixture.root)).toEqual(beforeTree)

    // Every produced path resolves inside the chosen output directory.
    for (const f of walkFiles(output)) {
      const rel = path.relative(output, f)
      expect(rel.startsWith('..')).toBe(false)
      expect(path.isAbsolute(rel)).toBe(false)
    }
  })

  it('collects a missing-source failure, keeps copying the rest, and still finishes at done === total', async () => {
    const db = tempDb()
    const batch = createBatch(db)
    const pick = createFolder(db, batch.id, '精选')
    const fixture = makeFixtureTree()
    await importFixture(db, batch.id, fixture.root)
    const inbox = listPhotos(db, batch.id, { kind: 'inbox' })
    assignToFolder(
      db,
      inbox.map((p) => p.id),
      pick.id
    )
    const victim = inbox.find((p) => p.filename === 'b.png')!
    fs.rmSync(victim.absPath)

    const output = tempDir('selight-export-out-')
    const progress: Array<[number, number]> = []
    const result = await exportBatch(db, batch.id, output, (done, total) =>
      progress.push([done, total])
    )

    expect(result.copied).toBe(4)
    expect(result.failures).toEqual([victim.absPath])
    const names = walkFiles(output).map((f) => path.basename(f)).sort()
    expect(names).toContain('a.jpg')
    expect(names).toContain('a (1).jpg')
    expect(names).toContain('c.webp')
    expect(names).toContain('d.arw')
    expect(names).not.toContain('b.png')
    expect(progress.at(-1)).toEqual([5, 5])
  })

  it('rejects an output path that does not exist or is not a directory', async () => {
    const db = tempDb()
    const batch = createBatch(db)
    const missing = path.join(tempDir('selight-export-missing-'), 'no-such-dir')
    await expect(exportBatch(db, batch.id, missing, () => undefined)).rejects.toBeInstanceOf(
      Error
    )

    const file = path.join(tempDir('selight-export-file-'), 'not-a-dir')
    fs.writeFileSync(file, 'x')
    await expect(exportBatch(db, batch.id, file, () => undefined)).rejects.toBeInstanceOf(Error)
  })

  it('returns an empty result for a batch with no folder photos and never touches the output dir', async () => {
    const db = tempDb()
    const batch = createBatch(db)
    createFolder(db, batch.id, '空文件夹')
    const output = tempDir('selight-export-out-')
    const calls: Array<[number, number]> = []

    const result = await exportBatch(db, batch.id, output, (done, total) => calls.push([done, total]))

    expect(result).toEqual({ copied: 0, failures: [] })
    expect(calls).toEqual([])
    expect(fs.readdirSync(output)).toEqual([])
  })
})

describe('uniqueDestination', () => {
  it('returns the plain filename when nothing collides', () => {
    const dir = tempDir('selight-unique-')
    expect(uniqueDestination(dir, 'a.jpg')).toBe(path.join(dir, 'a.jpg'))
  })

  it('appends (1), then (2) for repeated collisions, keeping the extension', () => {
    const dir = tempDir('selight-unique-')
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'x')
    expect(uniqueDestination(dir, 'a.jpg')).toBe(path.join(dir, 'a (1).jpg'))

    fs.writeFileSync(path.join(dir, 'a (1).jpg'), 'x')
    expect(uniqueDestination(dir, 'a.jpg')).toBe(path.join(dir, 'a (2).jpg'))
  })

  it('keeps only the final extension for names with multiple dots', () => {
    const dir = tempDir('selight-unique-')
    fs.writeFileSync(path.join(dir, 'a.b.jpg'), 'x')
    expect(uniqueDestination(dir, 'a.b.jpg')).toBe(path.join(dir, 'a.b (1).jpg'))
  })

  it('falls back to a suffix with no extension when the filename has none', () => {
    const dir = tempDir('selight-unique-')
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'x')
    expect(uniqueDestination(dir, 'LICENSE')).toBe(path.join(dir, 'LICENSE (1)'))
  })
})
