import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { EnrichmentService, enrichPhoto } from '../../electron/media/enrich'
import type { ExifReader, ImageMeta } from '../../electron/media/rawPreview'

const dirs: string[] = []
const handles: Database[] = []

afterEach(() => {
  while (handles.length) {
    const db = handles.pop()!
    if (db.open) db.close()
  }
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function tempDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-enrich-'))
  dirs.push(dir)
  const { db } = openDatabase(path.join(dir, 'selight.db'))
  handles.push(db)
  return db
}

function insertPhoto(
  db: Database,
  batchId: number,
  absPath: string,
  ext: string
): number {
  // One source row per imported directory: the unique index is (batch_id, abs_path).
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
  return Number(
    db
      .prepare(
        `INSERT INTO photos
           (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, status, missing)
         VALUES (?, ?, ?, ?, ?, 1, 1, 'inbox', 0)`
      )
      .run(batchId, sourceId, absPath, path.basename(absPath), ext).lastInsertRowid
  )
}

async function writeJpeg(
  file: string,
  opts: { width: number; height: number; orientation?: number }
): Promise<void> {
  let pipeline = sharp({
    create: {
      width: opts.width,
      height: opts.height,
      channels: 3,
      background: { r: 12, g: 34, b: 56, alpha: 1 }
    }
  })
  if (opts.orientation !== undefined) {
    pipeline = pipeline.withMetadata({ orientation: opts.orientation })
  }
  await pipeline.jpeg().toFile(file)
}

function fakeReader(meta: ImageMeta | ((file: string) => ImageMeta)): Pick<
  ExifReader,
  'readImageMeta'
> {
  return {
    readImageMeta: vi.fn(async (file: string) =>
      typeof meta === 'function' ? meta(file) : meta
    )
  }
}

describe('enrichPhoto', () => {
  it('writes orientation and display-state dimensions for a direct-format photo, once', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const file = path.join(dirs[0], 'vertical.jpg')
    // Stored 640x480 with EXIF 6: display state must be 480x640.
    await writeJpeg(file, { width: 640, height: 480, orientation: 6 })
    const id = insertPhoto(db, batchId, file, '.jpg')

    const before = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as Record<
      string,
      unknown
    >
    expect(await enrichPhoto(db, id, fakeReader({ orientation: 1, width: 1, height: 1 }))).toBe(
      true
    )
    const after = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as Record<
      string,
      unknown
    >
    expect(after.orientation).toBe(6)
    expect(after.width).toBe(480)
    expect(after.height).toBe(640)

    // Second call is a no-op: row already enriched, nothing changes.
    expect(await enrichPhoto(db, id, fakeReader({ orientation: 1, width: 1, height: 1 }))).toBe(
      false
    )
    const again = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as Record<
      string,
      unknown
    >
    expect(again).toEqual(after)
    expect(before.width).toBeNull()
  })

  it('keeps width NULL when a direct file cannot be decoded, so catch-up can retry', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const file = path.join(dirs[0], 'broken.jpg')
    fs.writeFileSync(file, Buffer.alloc(0))
    const id = insertPhoto(db, batchId, file, '.jpg')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await enrichPhoto(db, id, fakeReader({ orientation: 1, width: 1, height: 1 }))).toBe(
      false
    )
    const row = db.prepare('SELECT width, height, orientation FROM photos WHERE id = ?').get(
      id
    ) as Record<string, unknown>
    expect(row.width).toBeNull()
    expect(row.height).toBeNull()
    expect(row.orientation).toBe(1)
  })

  it('enriches a RAW row through the injected reader without opening the source', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const missing = path.join(dirs[0], 'shot.arw')
    const id = insertPhoto(db, batchId, missing, '.arw')
    const reader = fakeReader({ orientation: 8, width: 6000, height: 4000 })

    expect(await enrichPhoto(db, id, reader)).toBe(true)
    const row = db.prepare('SELECT orientation, width, height FROM photos WHERE id = ?').get(
      id
    ) as Record<string, number>
    // Orientation 8 swaps the stored axes into display state 4000x6000.
    expect(row).toEqual({ orientation: 8, width: 4000, height: 6000 })
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('treats RAW metadata without dimensions as a retryable failure', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const id = insertPhoto(db, batchId, path.join(dirs[0], 'no-dims.arw'), '.arw')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(
      await enrichPhoto(db, id, fakeReader({ orientation: 6, width: null, height: null }))
    ).toBe(false)
    const row = db.prepare('SELECT width FROM photos WHERE id = ?').get(id) as {
      width: number | null
    }
    expect(row.width).toBeNull()
  })
})

describe('EnrichmentService', () => {
  it('drains direct and RAW pools and fills every submitted row', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const jpg = path.join(dirs[0], 'a.jpg')
    const webp = path.join(dirs[0], 'b.webp')
    await writeJpeg(jpg, { width: 640, height: 480 })
    await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .webp()
      .toFile(webp)
    const jpgId = insertPhoto(db, batchId, jpg, '.jpg')
    const webpId = insertPhoto(db, batchId, webp, '.webp')
    const rawId = insertPhoto(db, batchId, path.join(dirs[0], 'x.arw'), '.arw')
    const reader = fakeReader({ orientation: 1, width: 100, height: 200 })

    const service = new EnrichmentService(db, reader)
    service.submit([jpgId, webpId, rawId])
    await service.whenIdle()

    const filled = db
      .prepare('SELECT COUNT(*) AS n FROM photos WHERE width IS NOT NULL')
      .get() as { n: number }
    expect(filled.n).toBe(3)
    service.stop()
  })

  it('re-submits a failed row on the next batch and processes it successfully', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const file = path.join(dirs[0], 'later.jpg')
    fs.writeFileSync(file, Buffer.alloc(0))
    const id = insertPhoto(db, batchId, file, '.jpg')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = new EnrichmentService(db, fakeReader({ orientation: 1, width: 1, height: 1 }))

    service.submit([id])
    await service.whenIdle()
    expect(
      (db.prepare('SELECT width FROM photos WHERE id = ?').get(id) as { width: number | null })
        .width
    ).toBeNull()

    // Replace the broken bytes with a real image and submit again.
    await writeJpeg(file, { width: 640, height: 480 })
    service.submit([id])
    await service.whenIdle()
    const row = db.prepare('SELECT width, height FROM photos WHERE id = ?').get(id) as {
      width: number
      height: number
    }
    expect(row).toEqual({ width: 640, height: 480 })
    service.stop()
  })

  it('reports monotonic aggregated progress across interleaved batches, ending done=total', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const ids: number[] = []
    for (let i = 0; i < 6; i += 1) {
      const file = path.join(dirs[0], `p${i}.jpg`)
      await writeJpeg(file, { width: 100, height: 80 })
      ids.push(insertPhoto(db, batchId, file, '.jpg'))
    }
    const events: Array<[number, number]> = []
    const service = new EnrichmentService(
      db,
      fakeReader({ orientation: 1, width: 1, height: 1 }),
      { directConcurrency: 1, onProgress: (done, total) => events.push([done, total]) }
    )

    service.submit(ids.slice(0, 4))
    service.submit(ids.slice(4))
    await service.whenIdle()

    expect(events).toHaveLength(6)
    let lastDone = 0
    for (const [done, total] of events) {
      expect(done).toBeGreaterThan(lastDone)
      expect(done).toBeLessThanOrEqual(total)
      lastDone = done
    }
    expect(events.at(-1)).toEqual([6, 6])
    service.stop()
  })

  it('never starts work submitted after stop', async () => {
    const db = tempDb()
    const batchId = createBatch(db).id
    const file = path.join(dirs[0], 'stopped.jpg')
    await writeJpeg(file, { width: 100, height: 80 })
    const id = insertPhoto(db, batchId, file, '.jpg')

    const service = new EnrichmentService(
      db,
      fakeReader({ orientation: 1, width: 1, height: 1 })
    )
    service.stop()
    service.submit([id])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(
      (db.prepare('SELECT width FROM photos WHERE id = ?').get(id) as { width: number | null })
        .width
    ).toBeNull()
  })
})
