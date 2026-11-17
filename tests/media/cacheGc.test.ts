import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { upsertPhoto } from '../../electron/domain/photos'
import { planCacheCleanup, runCacheCleanup } from '../../electron/media/cacheGc'
import type { MediaRoots } from '../../electron/media/resolve'

const dirs: string[] = []
const handles: Database[] = []

function setup(): { db: Database; roots: MediaRoots; sourceDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-gc-'))
  dirs.push(root)
  const { db } = openDatabase(path.join(root, 'selight.db'))
  handles.push(db)
  const thumbDir = path.join(root, 'thumbnails')
  const previewDir = path.join(root, 'previews')
  fs.mkdirSync(thumbDir, { recursive: true })
  fs.mkdirSync(previewDir, { recursive: true })
  const sourceDir = path.join(root, 'source')
  fs.mkdirSync(sourceDir, { recursive: true })
  return { db, roots: { thumbDir, previewDir }, sourceDir }
}

function addPhoto(db: Database, absPath: string, ext = '.jpg', missing = 0): number {
  const batchId = createBatch(db).id
  db.prepare(
    `INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)
       ON CONFLICT(batch_id, abs_path) DO NOTHING`
  ).run(batchId, path.dirname(absPath))
  const sourceId = Number(
    (
      db
        .prepare('SELECT id FROM sources WHERE batch_id = ? AND abs_path = ?')
        .get(batchId, path.dirname(absPath)) as { id: number }
    ).id
  )
  return upsertPhoto(db, {
    batchId,
    sourceId,
    absPath,
    filename: path.basename(absPath),
    ext,
    sizeBytes: 1,
    mtime: 1,
    ...(missing ? {} : {})
  }).row.id
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

describe('planCacheCleanup', () => {
  it('keeps artifacts for live, present photos', () => {
    const { db, roots } = setup()
    const id = addPhoto(db, 'E:/source/a.jpg')
    const thumb = path.join(roots.thumbDir, `${id}.jpg`)
    const preview = path.join(roots.previewDir, `${id}.jpg`)
    fs.writeFileSync(thumb, 'thumb')
    fs.writeFileSync(preview, 'preview')

    const plan = planCacheCleanup(db, roots)
    expect(plan).toEqual([])
  })

  it('collects artifacts whose photo id no longer exists (orphans)', () => {
    const { db, roots } = setup()
    addPhoto(db, 'E:/source/a.jpg')
    const orphanThumb = path.join(roots.thumbDir, '999.jpg')
    const orphanPreview = path.join(roots.previewDir, '999.jpg')
    fs.writeFileSync(orphanThumb, 'x')
    fs.writeFileSync(orphanPreview, 'x')

    const normalized = planCacheCleanup(db, roots).map((f) => f.split(path.sep).join('/'))
    expect(normalized).toContain(orphanThumb.split(path.sep).join('/'))
    expect(normalized).toContain(orphanPreview.split(path.sep).join('/'))
  })

  it('collects placeholders for photos flagged missing', () => {
    const { db, roots } = setup()
    const id = addPhoto(db, 'E:/source/gone.jpg', '.jpg', 1)
    db.prepare('UPDATE photos SET missing = 1 WHERE id = ?').run(id)
    const thumb = path.join(roots.thumbDir, `${id}.jpg`)
    const sidecar = `${thumb}.placeholder`
    fs.writeFileSync(thumb, 'placeholder')
    fs.writeFileSync(sidecar, '')

    const plan = planCacheCleanup(db, roots)
    expect(plan).toContain(thumb)
    expect(plan).toContain(sidecar)
  })

  it('collects an orphaned sidecar whose main artifact is absent', () => {
    const { db, roots } = setup()
    const id = addPhoto(db, 'E:/source/a.jpg')
    const orphanSidecar = path.join(roots.thumbDir, `${id}.jpg.placeholder`)
    fs.writeFileSync(orphanSidecar, '')

    expect(planCacheCleanup(db, roots)).toContain(orphanSidecar)
  })

  it('collects atomic-write .tmp leftovers even for live ids', () => {
    const { db, roots } = setup()
    const id = addPhoto(db, 'E:/source/a.jpg')
    const tmp = path.join(roots.thumbDir, `${id}.jpg.tmp`)
    fs.writeFileSync(tmp, 'partial')

    expect(planCacheCleanup(db, roots)).toContain(tmp)
  })

  it('never addresses files outside the cache roots and ignores non-managed names', () => {
    const { db, roots, sourceDir } = setup()
    const source = path.join(sourceDir, 'original.jpg')
    fs.writeFileSync(source, 'source-bytes')
    addPhoto(db, source)
    fs.writeFileSync(path.join(roots.thumbDir, 'notes.txt'), 'ignore me')

    const plan = planCacheCleanup(db, roots)
    expect(plan.every((f) => f.startsWith(roots.thumbDir) || f.startsWith(roots.previewDir))).toBe(
      true
    )
    expect(plan.some((f) => f.endsWith('notes.txt'))).toBe(false)
    expect(fs.readFileSync(source, 'utf8')).toBe('source-bytes')
  })
})

describe('runCacheCleanup', () => {
  it('deletes exactly the planned files and reports the count', async () => {
    const { db, roots } = setup()
    const liveId = addPhoto(db, 'E:/source/a.jpg')
    const live = path.join(roots.thumbDir, `${liveId}.jpg`)
    fs.writeFileSync(live, 'keep')
    const orphan = path.join(roots.previewDir, '999.jpg')
    fs.writeFileSync(orphan, 'remove')

    const result = await runCacheCleanup(db, roots)
    expect(fs.existsSync(live)).toBe(true)
    expect(fs.existsSync(orphan)).toBe(false)
    expect(result.removed).toBe(1)
  })
})
