import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

// Real libvips decode, no mocks: sharp ships prebuilt binaries and loads under
// bare-node Vitest exactly like better-sqlite3. Every source image is generated
// into a tmpdir fixture; the corpus is never opened for writing.
import {
  createThumbnailQueue,
  ensureThumbnail,
  PLACEHOLDER_JPEG_BYTES,
  type ThumbnailPhoto
} from '../../electron/media/thumbnails'
import { RawPreviewError } from '../../electron/media/rawPreview'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import type { Database } from 'better-sqlite3'
import { tinyJpeg } from './fixtures'

const dirs: string[] = []
const dbHandles: Database[] = []

function makeCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-thumb-'))
  dirs.push(dir)
  return dir
}

// 640x480 encoded buffer; orientation is written into EXIF metadata without
// rotating the stored pixels, exactly like a camera-produced file.
async function makeImage(opts: { ext: '.jpg' | '.webp'; orientation?: number }): Promise<Buffer> {
  let pipeline = sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 200, g: 100, b: 50, alpha: 1 }
    }
  })
  if (opts.orientation !== undefined) {
    pipeline = pipeline.withMetadata({ orientation: opts.orientation })
  }
  return pipeline.toFormat(opts.ext === '.jpg' ? 'jpeg' : 'webp').toBuffer()
}

interface FixturePhoto {
  photo: ThumbnailPhoto
  source: string
}

async function writeSource(
  name: string,
  image: Buffer,
  overrides: Partial<ThumbnailPhoto> = {}
): Promise<FixturePhoto> {
  const dir = makeCacheDir()
  const source = path.join(dir, name)
  await fs.promises.writeFile(source, image)
  const photo: ThumbnailPhoto = {
    id: 42,
    absPath: source,
    ext: path.extname(name).toLowerCase(),
    orientation: 1,
    width: null,
    missing: 0,
    ...overrides
  }
  return {
    source,
    photo
  }
}

function photo(overrides: Partial<ThumbnailPhoto> = {}): ThumbnailPhoto {
  return {
    id: 42,
    absPath: path.join(os.tmpdir(), 'selight-nonexistent-source.jpg'),
    ext: '.jpg',
    orientation: 1,
    width: null,
    missing: 0,
    ...overrides
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  while (dbHandles.length) {
    const db = dbHandles.pop()!
    if (db.open) db.close()
  }
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('ensureThumbnail sharp pipeline', () => {
  it('writes a real 320-long-edge JPEG for a healthy jpg, no sidecar, and serves cache hits without regenerating', async () => {
    const cacheDir = makeCacheDir()
    const { photo: p } = await writeSource('healthy.jpg', await makeImage({ ext: '.jpg' }))
    const out = path.join(cacheDir, '42.jpg')
    const marker = `${out}.placeholder`

    const first = await ensureThumbnail(p, cacheDir)
    expect(first).toEqual({ path: out, placeholder: false })
    const bytes = fs.readFileSync(out)
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(240)
    expect(fs.existsSync(marker)).toBe(false)

    const mtimeBefore = fs.statSync(out).mtimeMs
    const second = await ensureThumbnail(p, cacheDir)
    expect(second).toEqual({ path: out, placeholder: false })
    expect(fs.statSync(out).mtimeMs).toBe(mtimeBefore)
  })

  it.each([6, 8])('bakes EXIF orientation %s into a physically vertical thumbnail', async (orientation) => {
    const cacheDir = makeCacheDir()
    const { photo: p } = await writeSource(
      `vertical-${orientation}.jpg`,
      await makeImage({ ext: '.jpg', orientation }),
      { orientation }
    )

    const result = await ensureThumbnail(p, cacheDir)
    expect(result.placeholder).toBe(false)
    const meta = await sharp(result.path).metadata()
    expect(meta.width).toBeLessThan(meta.height!)
    expect(meta.height).toBe(320)
  })

  it('decodes webp through sharp without any helper boundary', async () => {
    const cacheDir = makeCacheDir()
    const { photo: p } = await writeSource('p.webp', await makeImage({ ext: '.webp' }))

    const result = await ensureThumbnail(p, cacheDir)
    expect(result).toEqual({ path: path.join(cacheDir, '42.jpg'), placeholder: false })
    expect(fs.readFileSync(result.path).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(fs.existsSync(`${result.path}.placeholder`)).toBe(false)
  })

  it('accepts upper-case extensions (.JPG, .WEBP)', async () => {
    const cacheDir = makeCacheDir()
    const { photo: jpg } = await writeSource('UPPER.JPG', await makeImage({ ext: '.jpg' }), {
      ext: '.JPG'
    })
    const jpgResult = await ensureThumbnail(jpg, cacheDir)
    expect(jpgResult.placeholder).toBe(false)
    expect((await sharp(jpgResult.path).metadata()).width).toBe(320)

    const { photo: webp } = await writeSource('UPPER.WEBP', await makeImage({ ext: '.webp' }), {
      ext: '.WEBP'
    })
    const webpResult = await ensureThumbnail(webp, makeCacheDir())
    expect(webpResult.placeholder).toBe(false)
    expect((await sharp(webpResult.path).metadata()).width).toBe(320)
  })

  it('accepts an upper-case RAW extension through the extracted-preview branch', async () => {
    const cacheDir = makeCacheDir()
    const previewDir = makeCacheDir()
    const extracted = path.join(previewDir, '42.jpg')
    await fs.promises.writeFile(extracted, await makeImage({ ext: '.jpg' }))
    const p = photo({ ext: '.ARW' })

    const result = await ensureThumbnail(p, cacheDir, {
      previewDir,
      reader: {
        ensureRawPreview: async () => extracted,
        readImageMeta: async () => ({ orientation: 1, width: 640, height: 480 })
      }
    })
    expect(result.placeholder).toBe(false)
    expect((await sharp(result.path).metadata()).width).toBe(320)
  })

  it('degrades a non-image file with an image extension to placeholder + sidecar', async () => {
    const cacheDir = makeCacheDir()
    const { photo: p } = await writeSource('fake.jpg', Buffer.from('plain text, not an image'))

    const result = await ensureThumbnail(p, cacheDir)
    expect(result).toEqual({ path: path.join(cacheDir, '42.jpg'), placeholder: true })
    expect(fs.existsSync(`${result.path}.placeholder`)).toBe(true)
    expect(fs.readFileSync(result.path)).toEqual(PLACEHOLDER_JPEG_BYTES)
  })

  it('pins the failOn:none contract: a mid-file truncated JPEG still yields a usable thumbnail', async () => {
    // Explicit decision, not an accident: failOn:'none' trades strict rejection
    // for a recoverable partial image over a permanent placeholder. v1 has no
    // retry flow (backlog I7), so this behavior is pinned here instead of being
    // discovered from a half-rendered grid cell.
    const cacheDir = makeCacheDir()
    const full = await makeImage({ ext: '.jpg' })
    const { photo: p } = await writeSource(
      'truncated-middle.jpg',
      full.subarray(0, Math.floor(full.length / 2))
    )

    const result = await ensureThumbnail(p, cacheDir)
    expect(result.placeholder).toBe(false)
    expect(fs.existsSync(`${result.path}.placeholder`)).toBe(false)
    const meta = await sharp(result.path).metadata()
    expect(meta.width).toBe(320)
  })

  it.each([
    ['zero-byte', Buffer.alloc(0)],
    ['truncated', tinyJpeg().subarray(0, 50)]
  ])('degrades a %s file to placeholder + sidecar and never retries on cache hit', async (_name, broken) => {
    const cacheDir = makeCacheDir()
    const { photo: p } = await writeSource('broken.jpg', broken)
    const out = path.join(cacheDir, '42.jpg')
    const marker = `${out}.placeholder`

    const first = await ensureThumbnail(p, cacheDir)
    expect(first).toEqual({ path: out, placeholder: true })
    expect(fs.readFileSync(out)).toEqual(PLACEHOLDER_JPEG_BYTES)
    expect(fs.existsSync(marker)).toBe(true)

    const mtimeBefore = fs.statSync(out).mtimeMs
    const second = await ensureThumbnail(p, cacheDir)
    expect(second.placeholder).toBe(true)
    expect(fs.statSync(out).mtimeMs).toBe(mtimeBefore)
  })

  it('marks a missing=1 photo with placeholder without touching the absent source', async () => {
    const cacheDir = makeCacheDir()
    const p = photo({ missing: 1 })
    const out = path.join(cacheDir, '42.jpg')

    const result = await ensureThumbnail(p, cacheDir)
    expect(result).toEqual({ path: out, placeholder: true })
    expect(fs.existsSync(`${out}.placeholder`)).toBe(true)
    expect(fs.readFileSync(out)).toEqual(PLACEHOLDER_JPEG_BYTES)
  })

  it('wraps a RAW ensureRawPreview rejection (RawPreviewError) into placeholder + sidecar', async () => {
    const cacheDir = makeCacheDir()
    const previewDir = makeCacheDir()
    const p = photo({ ext: '.arw' })

    const result = await ensureThumbnail(p, cacheDir, {
      previewDir,
      reader: {
        ensureRawPreview: async () => {
          throw new RawPreviewError('no embedded preview')
        },
        readImageMeta: async () => ({ orientation: 1, width: 640, height: 480 })
      }
    })
    expect(result.placeholder).toBe(true)
    expect(fs.existsSync(`${path.join(cacheDir, '42.jpg')}.placeholder`)).toBe(true)
  })

  describe('createThumbnailQueue self-heal and readiness', () => {
    let db: Database
    let dbDir: string
    let thumbDir: string
    let previewDir: string
    let batchId: number

    beforeEach(() => {
      dbDir = makeCacheDir()
      db = openDatabase(path.join(dbDir, 'selight.db')).db
      dbHandles.push(db)
      thumbDir = path.join(dbDir, 'thumbnails')
      previewDir = path.join(dbDir, 'previews')
      fs.mkdirSync(thumbDir)
      fs.mkdirSync(previewDir)
      batchId = createBatch(db).id
    })

    function insertRawRow(): number {
      const sourceId = Number(
        db
          .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
          .run(batchId, path.join(dbDir, 'shot.arw')).lastInsertRowid
      )
      return Number(
        db
          .prepare(
            `INSERT INTO photos
               (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, status, missing)
             VALUES (?, ?, ?, 'shot.arw', '.arw', 1, 1, 'inbox', 0)`
          )
          .run(batchId, sourceId, path.join(dbDir, 'shot.arw')).lastInsertRowid
      )
    }

    function drain(queue: { onIdle(cb: () => void): void; stop(): void }): Promise<void> {
      return new Promise((resolve) => {
        queue.onIdle(() => resolve())
      })
    }

    it('enriches an unenriched RAW before extracting its preview, then reports ready ok', async () => {
      const id = insertRawRow()
      const readImageMeta = vi.fn(async () => ({
        orientation: 6,
        width: 6000,
        height: 4000
      }))
      const ensureRawPreview = vi.fn(async () => {
        const file = path.join(previewDir, `${id}.jpg`)
        await fs.promises.writeFile(file, await makeImage({ ext: '.jpg' }))
        return file
      })
      const onReady = vi.fn()
      const queue = createThumbnailQueue(
        db,
        { thumbDir, previewDir },
        { readImageMeta, ensureRawPreview },
        onReady
      )

      queue.enqueue([id])
      await drain(queue)
      queue.stop()

      // Self-heal must precede preview extraction, or a wrong-orientation
      // thumbnail would be cached permanently.
      expect(readImageMeta.mock.invocationCallOrder[0]).toBeLessThan(
        ensureRawPreview.mock.invocationCallOrder[0]
      )
      const row = db
        .prepare('SELECT orientation, width, height FROM photos WHERE id = ?')
        .get(id) as { orientation: number; width: number; height: number }
      expect(row).toEqual({ orientation: 6, width: 4000, height: 6000 })
      expect(fs.existsSync(path.join(thumbDir, `${id}.jpg`))).toBe(true)
      expect(fs.existsSync(`${path.join(thumbDir, `${id}.jpg`)}.placeholder`)).toBe(false)
      expect(onReady).toHaveBeenCalledWith(id, true)
    })

    it('reports ready ok:false and keeps the sidecar when generation fails', async () => {
      const dir = makeCacheDir()
      const source = path.join(dir, 'broken.jpg')
      fs.writeFileSync(source, Buffer.alloc(0))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const sourceId = Number(
        db
          .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
          .run(batchId, dir).lastInsertRowid
      )
      const id = Number(
        db
          .prepare(
            `INSERT INTO photos
               (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, status, missing)
             VALUES (?, ?, ?, 'broken.jpg', '.jpg', 0, 1, 'inbox', 0)`
          )
          .run(batchId, sourceId, source).lastInsertRowid
      )
      const onReady = vi.fn()
      const queue = createThumbnailQueue(db, { thumbDir, previewDir }, undefined, onReady)
      queue.enqueue([id])
      await drain(queue)
      queue.stop()

      expect(onReady).toHaveBeenCalledWith(id, false)
      expect(fs.existsSync(`${path.join(thumbDir, `${id}.jpg`)}.placeholder`)).toBe(true)
    })
  })
})

describe('ensureThumbnail sharp pipeline — remaining cases', () => {
  it('resizes an extracted RAW preview through sharp and clears a stale sidecar', async () => {
    const cacheDir = makeCacheDir()
    const previewDir = makeCacheDir()
    const extracted = path.join(previewDir, '42.jpg')
    await fs.promises.writeFile(extracted, await makeImage({ ext: '.jpg' }))
    const p = photo({ ext: '.arw' })
    const out = path.join(cacheDir, '42.jpg')
    fs.writeFileSync(`${out}.placeholder`, '')

    const result = await ensureThumbnail(p, cacheDir, {
      previewDir,
      reader: {
        ensureRawPreview: async () => extracted,
        readImageMeta: async () => ({ orientation: 1, width: 640, height: 480 })
      }
    })
    expect(result).toEqual({ path: out, placeholder: false })
    expect(fs.existsSync(`${out}.placeholder`)).toBe(false)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(320)
  })
})
