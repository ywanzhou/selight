import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../electron/db/schema'
import { createBatch, getBatch } from '../electron/domain/batches'
import { createFolder, softDeleteFolder } from '../electron/domain/folders'
import { upsertPhoto, type PhotoInput } from '../electron/domain/photos'
import {
  buildManifest,
  exportManifest,
  safeFileName,
  toPosix,
  writeManifest,
  type Manifest
} from '../electron/manifest'

const dirs: string[] = []
const handles: Database[] = []

function tempDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-manifest-'))
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

const NOW = new Date(2026, 10, 18, 15, 0).getTime()

function addSource(db: Database, batchId: number, absPath: string): number {
  const info = db
    .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
    .run(batchId, absPath)
  return Number(info.lastInsertRowid)
}

function makePhoto(
  db: Database,
  batchId: number,
  sourceId: number,
  absPath: string,
  overrides: Partial<PhotoInput> = {}
): number {
  const input: PhotoInput = {
    batchId,
    sourceId,
    absPath,
    filename: path.basename(absPath),
    ext: path.extname(absPath),
    sizeBytes: 1024,
    mtime: 1_700_000_000_000,
    ...overrides
  }
  return upsertPhoto(db, input).row.id
}

function assignToFolder(db: Database, photoId: number, folderId: number): void {
  db.prepare("UPDATE photos SET status = 'folder', folder_id = ? WHERE id = ?").run(
    folderId,
    photoId
  )
}

describe('toPosix', () => {
  it('converts the platform separator to forward slashes', () => {
    // Build the input from path.sep so the same assertion holds on Windows ('\\')
    // and POSIX ('/'): a hard-coded backslash string would fail on the mac CI target.
    const platformPath = ['a', 'b', 'c.ARW'].join(path.sep)
    expect(toPosix(platformPath)).toBe('a/b/c.ARW')
  })

  it('leaves posix paths untouched', () => {
    expect(toPosix('a/b/c.ARW')).toBe('a/b/c.ARW')
  })
})

describe('safeFileName', () => {
  it('replaces every Windows-illegal character with an underscore', () => {
    expect(safeFileName('婚礼?a*b|c<d>e:f"g/h\\i')).toBe('婚礼_a_b_c_d_e_f_g_h_i')
  })

  it('falls back to "manifest" for empty or whitespace-only names', () => {
    expect(safeFileName('')).toBe('manifest')
    expect(safeFileName('   ')).toBe('manifest')
  })
})

describe('buildManifest', () => {
  it('describes an empty batch with the fixed kind/version and ISO timestamp', () => {
    const db = tempDb()
    const batch = createBatch(db, '空批次')
    const manifest = buildManifest(db, batch.id, NOW)

    expect(manifest.kind).toBe('selight-manifest')
    expect(manifest.version).toBe(1)
    expect(manifest.batch).toEqual({
      id: batch.id,
      name: '空批次',
      exportedAt: new Date(NOW).toISOString()
    })
    expect(manifest.sources).toEqual([])
    expect(manifest.folders).toEqual([])
  })

  it('maps photos to posix paths relative to their own source root across multiple sources', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const rootA = 'E:/wedding'
    const rootB = 'D:/cards'
    const sourceA = addSource(db, batch.id, rootA)
    const sourceB = addSource(db, batch.id, rootB)
    const folder = createFolder(db, batch.id, '仪式')

    const a = makePhoto(db, batch.id, sourceA, 'E:/wedding/ceremony/a.ARW', {
      sizeBytes: 64_172_800
    })
    const b = makePhoto(db, batch.id, sourceB, 'D:/cards/portrait/b.jpg')
    assignToFolder(db, a, folder.id)
    assignToFolder(db, b, folder.id)

    const manifest = buildManifest(db, batch.id, NOW)

    expect(manifest.sources).toEqual([
      { id: sourceA, root: rootA },
      { id: sourceB, root: rootB }
    ])
    expect(manifest.folders).toHaveLength(1)
    const group = manifest.folders[0]
    expect(group).toMatchObject({ id: folder.id, name: '仪式' })
    expect(group.photos).toHaveLength(2)
    const photoA = group.photos.find((p) => p.filename === 'a.ARW')!
    expect(photoA).toMatchObject({
      sourceId: sourceA,
      path: 'ceremony/a.ARW',
      absPath: 'E:/wedding/ceremony/a.ARW',
      sizeBytes: 64_172_800,
      missing: false
    })
    const photoB = group.photos.find((p) => p.filename === 'b.jpg')!
    expect(photoB.path).toBe('portrait/b.jpg')
    expect(photoB.sourceId).toBe(sourceB)
  })

  it('excludes inbox photos, trash photos, empty folders and soft-deleted folders', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const source = addSource(db, batch.id, 'E:/root')
    const live = createFolder(db, batch.id, '有照片')
    const empty = createFolder(db, batch.id, '空文件夹')
    const deleted = createFolder(db, batch.id, '已删除文件夹')
    softDeleteFolder(db, deleted.id)

    const inFolder = makePhoto(db, batch.id, source, 'E:/root/a.jpg')
    makePhoto(db, batch.id, source, 'E:/root/b.jpg') // stays inbox by default
    const trashed = makePhoto(db, batch.id, source, 'E:/root/c.jpg')
    const inDeleted = makePhoto(db, batch.id, source, 'E:/root/d.jpg')
    assignToFolder(db, inFolder, live.id)
    assignToFolder(db, trashed, live.id)
    db.prepare("UPDATE photos SET status = 'trash' WHERE id = ?").run(trashed)
    assignToFolder(db, inDeleted, deleted.id)

    const manifest = buildManifest(db, batch.id, NOW)

    expect(manifest.folders.map((f) => f.name)).toEqual(['有照片'])
    const names = manifest.folders.flatMap((f) => f.photos.map((p) => p.filename))
    expect(names).toEqual(['a.jpg'])
    expect(manifest.folders.map((f) => f.id)).not.toContain(empty.id)
  })

  it('carries the missing flag from the database row', () => {
    const db = tempDb()
    const batch = createBatch(db)
    const source = addSource(db, batch.id, 'E:/root')
    const folder = createFolder(db, batch.id, '精选')
    const present = makePhoto(db, batch.id, source, 'E:/root/a.jpg')
    const gone = makePhoto(db, batch.id, source, 'E:/root/b.jpg')
    assignToFolder(db, present, folder.id)
    assignToFolder(db, gone, folder.id)
    db.prepare('UPDATE photos SET missing = 1 WHERE id = ?').run(gone)

    const manifest = buildManifest(db, batch.id, NOW)
    const flags = new Map(
      manifest.folders[0].photos.map((p) => [p.filename, p.missing])
    )
    expect(flags.get('a.jpg')).toBe(false)
    expect(flags.get('b.jpg')).toBe(true)
  })
})

describe('writeManifest', () => {
  it('writes pretty-printed JSON with a trailing newline and leaves no tmp sibling', async () => {
    const db = tempDb()
    const batch = createBatch(db, '测试批次')
    const manifest = buildManifest(db, batch.id, NOW)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-manifest-write-'))
    dirs.push(dir)
    const target = path.join(dir, '择影清单.json')

    await writeManifest(target, manifest)

    const text = fs.readFileSync(target, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  ')
    expect(JSON.parse(text) as Manifest).toEqual(manifest)
    expect(fs.existsSync(`${target}.tmp`)).toBe(false)
  })
})

describe('exportManifest', () => {
  it('writes the file and reports folder, photo and missing counts', async () => {
    const db = tempDb()
    const batch = getBatch(db, createBatch(db, '婚礼').id)!
    const source = addSource(db, batch.id, 'E:/root')
    const first = createFolder(db, batch.id, '全家福')
    const second = createFolder(db, batch.id, '仪式')

    const p1 = makePhoto(db, batch.id, source, 'E:/root/a.jpg')
    const p2 = makePhoto(db, batch.id, source, 'E:/root/b.jpg')
    const p3 = makePhoto(db, batch.id, source, 'E:/root/c.jpg')
    assignToFolder(db, p1, first.id)
    assignToFolder(db, p2, first.id)
    assignToFolder(db, p3, second.id)
    db.prepare('UPDATE photos SET missing = 1 WHERE id = ?').run(p3)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-manifest-export-'))
    dirs.push(dir)
    const target = path.join(dir, 'manifest.json')

    const result = await exportManifest(db, batch.id, target, NOW)

    expect(result).toEqual({
      targetPath: target,
      folderCount: 2,
      photoCount: 3,
      missingCount: 1
    })
    expect(fs.existsSync(target)).toBe(true)
  })
})
