import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { MediaQueue } from '../../electron/media/queue'
import {
  resolveMediaPath,
  type MediaRoots,
  type ResolveResult
} from '../../electron/media/resolve'

const dirs: string[] = []
const handles: Database[] = []

function tempLayout(): { db: Database; roots: MediaRoots; outside: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-proto-'))
  dirs.push(dir)
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)
  const thumbDir = path.join(dir, 'thumbnails')
  const previewDir = path.join(dir, 'previews')
  fs.mkdirSync(thumbDir)
  fs.mkdirSync(previewDir)
  const outside = path.join(dir, 'outside')
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

function forbidden(result: ResolveResult): boolean {
  return result.ok === false && result.reason === 'forbidden'
}

describe('resolveMediaPath — thumb route', () => {
  it('resolves an existing <id>.jpg inside thumbDir and never escapes it', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(roots.thumbDir, `${id}.jpg`))
    touch(path.join(roots.thumbDir, 'evil.jpg'))
    touch(path.join(outside, 'escape.jpg'))

    const resolved = resolveMediaPath(db, roots, 'thumb', id)
    expect(resolved).toEqual({
      ok: true,
      file: path.resolve(roots.thumbDir, `${id}.jpg`)
    })
    const again = resolveMediaPath(db, roots, 'thumb', String(id))
    expect(again).toEqual(resolved)
  })

  it('reports not-generated with the id when the thumbnail file is missing', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    expect(resolveMediaPath(db, roots, 'thumb', id)).toEqual({
      ok: false,
      reason: 'not-generated',
      id
    })
  })

  it('rejects unknown, non-numeric and traversal ids as forbidden', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(roots.thumbDir, `${id}.jpg`))

    for (const bad of [
      999,
      0,
      -1,
      1.5,
      'abc',
      '',
      '..',
      '../outside/escape',
      '../../escape',
      '1/../evil',
      '1.jpg.placeholder',
      '%2e%2e%2f1'
    ]) {
      const result = resolveMediaPath(db, roots, 'thumb', bad as never)
      expect(forbidden(result), `id=${JSON.stringify(bad)}`).toBe(true)
    }
  })

  it('treats missing photos as forbidden even if a thumb file exists', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'gone.jpg', { missing: 1 })
    touch(path.join(roots.thumbDir, `${id}.jpg`))
    expect(forbidden(resolveMediaPath(db, roots, 'thumb', id))).toBe(true)
  })

  it('never serves a source file outside thumbDir through the thumb route', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(outside, 'a.jpg'))
    const result = resolveMediaPath(db, roots, 'thumb', id)
    expect(result.ok === false && result.reason).toBe('not-generated')
  })

  it('dedupes repeated not-generated ids through a real MediaQueue (worker runs once)', async () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    const runs: number[] = []
    const queue = new MediaQueue(async (jobId) => {
      runs.push(jobId)
    })
    const onMissing = (missingId: number): void => {
      queue.enqueue([missingId])
    }

    // Three rapid 404s for the same ungenerated thumbnail, like grid remounts.
    for (let i = 0; i < 3; i += 1) {
      const result = resolveMediaPath(db, roots, 'thumb', id)
      if (result.ok === false && result.reason === 'not-generated') {
        onMissing(result.id)
      }
    }
    await new Promise<void>((resolve) => queue.onIdle(resolve))

    expect(runs).toEqual([id])
    queue.stop()
  })
})

describe('resolveMediaPath — photo route (phase 2: original bytes still served)', () => {
  it('serves a registered direct-format source file even when it lives outside the roots', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'photo.jpg')
    touch(absPath)
    const id = insertPhoto(db, outside, 'photo.jpg', { absPath })

    expect(resolveMediaPath(db, roots, 'photo', id)).toEqual({
      ok: true,
      file: path.resolve(absPath)
    })
  })

  it('reports not-generated when a direct-format source file has vanished from disk', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'vanish.jpg')
    touch(absPath)
    const id = insertPhoto(db, outside, 'vanish.jpg', { absPath })
    fs.rmSync(absPath)
    expect(resolveMediaPath(db, roots, 'photo', id)).toEqual({
      ok: false,
      reason: 'not-generated',
      id
    })
  })

  it('serves RAW photos only from the preview cache, never the source path', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'shot.arw')
    touch(absPath)
    const id = insertPhoto(db, outside, 'shot.arw', { ext: '.arw', absPath })

    expect(resolveMediaPath(db, roots, 'photo', id)).toEqual({
      ok: false,
      reason: 'not-generated',
      id
    })

    touch(path.join(roots.previewDir, `${id}.jpg`))
    const resolved = resolveMediaPath(db, roots, 'photo', id)
    expect(resolved).toEqual({ ok: true, file: path.resolve(roots.previewDir, `${id}.jpg`) })
  })

  it('rejects unknown, non-numeric and traversal ids as forbidden', () => {
    const { db, roots } = tempLayout()
    for (const bad of [
      999,
      0,
      -1,
      1.5,
      'abc',
      '',
      '..',
      '../../etc/passwd',
      '1/../../x',
      '1.jpg.placeholder',
      '%2e%2e%2f1'
    ]) {
      const result = resolveMediaPath(db, roots, 'photo', bad as never)
      expect(forbidden(result), `id=${JSON.stringify(bad)}`).toBe(true)
    }
  })

  it('returns forbidden for missing photos', () => {
    const { db, roots, outside } = tempLayout()
    const absPath = path.join(outside, 'gone.jpg')
    touch(absPath)
    const id = insertPhoto(db, outside, 'gone.jpg', { absPath, missing: 1 })
    expect(forbidden(resolveMediaPath(db, roots, 'photo', id))).toBe(true)
  })

  it('rejects an unknown kind as forbidden', () => {
    const { db, roots, outside } = tempLayout()
    const id = insertPhoto(db, outside, 'a.jpg')
    touch(path.join(roots.thumbDir, `${id}.jpg`))
    // @ts-expect-error exercising runtime defence against a bad host segment
    expect(forbidden(resolveMediaPath(db, roots, 'evil', id))).toBe(true)
  })
})
