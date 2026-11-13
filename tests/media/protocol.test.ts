import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { resolveMediaPath, type MediaRoots } from '../../electron/media/resolve'

const dirs: string[] = []
const handles: Database[] = []

function tempLayout(): { db: Database; roots: MediaRoots; outside: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-proto-'))
  dirs.push(dir)
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)
  const thumbDir = path.join(dir, 'thumbnails')
  const previewDir = path.join(dir, 'previews')
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(thumbDir)
  fs.mkdirSync(previewDir)
  fs.mkdirSync(outside)
  return { db, roots: { thumbDir, previewDir }, outside }
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

function touch(file: string, contents = 'x'): void {
  fs.writeFileSync(file, contents)
}

interface InsertOpts {
  ext?: string
  missing?: number
  absPath?: string
}

function insertPhoto(
  db: Database,
  outside: string,
  name: string,
  opts: InsertOpts = {}
): number {
  db.prepare('INSERT INTO batches (name) VALUES (?)').run('b')
  const batchId = Number(
    (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  )
  const absPath = opts.absPath ?? path.join(outside, name)
  db.prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)').run(batchId, absPath)
  const sourceId = Number(
    (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  )
  const info = db
    .prepare(
      `INSERT INTO photos
         (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, orientation, status, missing)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1, 'inbox', ?)`
    )
    .run(
      batchId,
      sourceId,
      absPath,
      path.basename(absPath),
      opts.ext ?? path.extname(name),
      opts.missing ?? 0
    )
  return Number(info.lastInsertRowid)
}

describe('resolveMediaPath — thumb route', () => {
  it('resolves an existing <id>.jpg inside thumbDir and never escapes it', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(roots.thumbDir, `${id}.jpg`))
    // Decoy with a non-numeric name must be unaddressable.
    touch(path.join(roots.thumbDir, 'evil.jpg'))
    // Decoy reachable only by traversal.
    touch(path.join(outside, 'escape.jpg'))

    const resolved = resolveMediaPath(db, roots, 'thumb', id)
    expect(resolved).toBe(path.resolve(roots.thumbDir, `${id}.jpg`))
    expect(resolved!.startsWith(path.resolve(roots.thumbDir) + path.sep)).toBe(true)

    // Numeric strings are accepted.
    expect(resolveMediaPath(db, roots, 'thumb', String(id))).toBe(resolved)
  })

  it('returns null when the thumbnail file has not been generated yet', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    expect(resolveMediaPath(db, roots, 'thumb', id)).toBeNull()
  })

  it('rejects unknown, non-numeric and traversal ids', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(roots.thumbDir, `${id}.jpg`))

    for (const bad of [999, 0, -1, 1.5, 'abc', '', '..', '../outside/escape', '../../escape', '1/../evil']) {
      expect(resolveMediaPath(db, roots, 'thumb', bad as never), `id=${JSON.stringify(bad)}`).toBeNull()
    }
  })

  it('returns null for missing photos even if a thumb file exists', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'gone.jpg', { missing: 1 })
    touch(path.join(roots.thumbDir, `${id}.jpg`))
    expect(resolveMediaPath(db, roots, 'thumb', id)).toBeNull()
  })

  it('never serves a source file outside thumbDir through the thumb route', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(outside, 'a.jpg'))
    expect(resolveMediaPath(db, roots, 'thumb', id)).toBeNull()
  })
})

describe('resolveMediaPath — photo route', () => {
  it('serves a registered direct-format source file even when it lives outside the roots', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'photo.jpg')
    touch(absPath)
    const id = insertPhoto(db, outside, 'photo.jpg', { absPath })

    expect(resolveMediaPath(db, roots, 'photo', id)).toBe(path.resolve(absPath))
  })

  it('returns null when a direct-format source file has vanished from disk', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'vanish.jpg')
    touch(absPath)
    const id = insertPhoto(db, outside, 'vanish.jpg', { absPath })
    fs.rmSync(absPath)
    expect(resolveMediaPath(db, roots, 'photo', id)).toBeNull()
  })

  it('serves RAW photos only from the preview cache, never the source path', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'shot.arw')
    touch(absPath)
    const id = insertPhoto(db, outside, 'shot.arw', { ext: '.arw', absPath })

    // No cached preview yet.
    expect(resolveMediaPath(db, roots, 'photo', id)).toBeNull()

    touch(path.join(roots.previewDir, `${id}.jpg`))
    const resolved = resolveMediaPath(db, roots, 'photo', id)
    expect(resolved).toBe(path.resolve(roots.previewDir, `${id}.jpg`))
    expect(resolved).not.toBe(path.resolve(absPath))
  })

  it('rejects unknown, non-numeric and traversal ids', () => {
    const { db, roots } = tempLayout()
    for (const bad of [999, 0, -1, 1.5, 'abc', '', '..', '../../etc/passwd', '1/../../x']) {
      expect(resolveMediaPath(db, roots, 'photo', bad as never), `id=${JSON.stringify(bad)}`).toBeNull()
    }
  })

  it('returns null for missing photos', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'gone.jpg')
    touch(absPath)
    const id = insertPhoto(db, outside, 'gone.jpg', { absPath, missing: 1 })
    expect(resolveMediaPath(db, roots, 'photo', id)).toBeNull()
  })

  it('rejects an unknown kind', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(roots.thumbDir, `${id}.jpg`))
    // @ts-expect-error exercising runtime defence against a bad host segment
    expect(resolveMediaPath(db, roots, 'evil', id)).toBeNull()
  })
})
