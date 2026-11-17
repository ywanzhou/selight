import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  ensurePreview,
  PLACEHOLDER_JPEG_BYTES,
  type PreviewPhoto
} from '../../electron/media/previews'
import { RawPreviewError } from '../../electron/media/rawPreview'
import { tinyJpeg } from './fixtures'

const dirs: string[] = []

function makeCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-preview-'))
  dirs.push(dir)
  return dir
}

async function makeImage(opts: {
  ext: '.jpg' | '.webp'
  width?: number
  height?: number
  orientation?: number
}): Promise<Buffer> {
  let pipeline = sharp({
    create: {
      width: opts.width ?? 3000,
      height: opts.height ?? 2000,
      channels: 3,
      background: { r: 200, g: 100, b: 50, alpha: 1 }
    }
  })
  if (opts.orientation !== undefined) {
    pipeline = pipeline.withMetadata({ orientation: opts.orientation })
  }
  return pipeline.toFormat(opts.ext === '.jpg' ? 'jpeg' : 'webp').toBuffer()
}

async function writeSource(name: string, image: Buffer): Promise<string> {
  const dir = makeCacheDir()
  const source = path.join(dir, name)
  await fs.promises.writeFile(source, image)
  return source
}

function photo(overrides: Partial<PreviewPhoto> = {}): PreviewPhoto {
  return {
    id: 42,
    absPath: path.join(os.tmpdir(), 'selight-missing-source.jpg'),
    ext: '.jpg',
    orientation: 1,
    width: null,
    missing: 0,
    ...overrides
  }
}

function roots(): { thumbDir: string; previewDir: string } {
  const previewDir = makeCacheDir()
  const thumbDir = makeCacheDir()
  return { thumbDir, previewDir }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('ensurePreview 2048 pipeline', () => {
  it('writes a long-edge-2048 JPEG for a healthy direct-format photo, no sidecar, cache hit skips rewrite', async () => {
    const { thumbDir, previewDir } = roots()
    const source = await writeSource('big.jpg', await makeImage({ ext: '.jpg' }))
    const p = photo({ absPath: source })
    const out = path.join(previewDir, '42.jpg')

    const first = await ensurePreview(p, { thumbDir, previewDir })
    expect(first).toEqual({ path: out, placeholder: false })
    const meta = await sharp(out).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(2048)
    expect(fs.existsSync(`${out}.placeholder`)).toBe(false)

    const mtime = fs.statSync(out).mtimeMs
    const second = await ensurePreview(p, { thumbDir, previewDir })
    expect(second.placeholder).toBe(false)
    expect(fs.statSync(out).mtimeMs).toBe(mtime)
  })

  it('does not upscale a source smaller than 2048', async () => {
    const { thumbDir, previewDir } = roots()
    const source = await writeSource('small.jpg', await makeImage({ ext: '.jpg', width: 400, height: 300 }))
    const result = await ensurePreview(photo({ absPath: source }), { thumbDir, previewDir })
    const meta = await sharp(result.path).metadata()
    expect(meta.width).toBe(400)
    expect(meta.height).toBe(300)
  })

  it.each([6, 8])('bakes EXIF orientation %s into a physically vertical preview', async (orientation) => {
    const { thumbDir, previewDir } = roots()
    const source = await writeSource(
      `v-${orientation}.jpg`,
      await makeImage({ ext: '.jpg', orientation })
    )
    const result = await ensurePreview(
      photo({ absPath: source, orientation }),
      { thumbDir, previewDir }
    )
    const meta = await sharp(result.path).metadata()
    expect(meta.width!).toBeLessThan(meta.height!)
  })

  it('decodes webp through the same pipeline', async () => {
    const { thumbDir, previewDir } = roots()
    const source = await writeSource('p.webp', await makeImage({ ext: '.webp' }))
    const result = await ensurePreview(photo({ absPath: source, ext: '.webp' }), {
      thumbDir,
      previewDir
    })
    expect(fs.readFileSync(result.path).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  })

  it('downscales the extracted RAW embedded preview through the reader', async () => {
    const { thumbDir, previewDir } = roots()
    const extracted = path.join(previewDir, 'raw-embedded.jpg')
    await fs.promises.writeFile(extracted, await makeImage({ ext: '.jpg' }))
    const result = await ensurePreview(
      photo({ ext: '.arw' }),
      { thumbDir, previewDir },
      {
        previewDir,
        reader: {
          ensureRawPreview: async () => extracted,
          readImageMeta: async () => ({ orientation: 1, width: 6000, height: 4000 })
        }
      }
    )
    expect(result.placeholder).toBe(false)
    const meta = await sharp(result.path).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(2048)
  })

  it.each([
    ['zero-byte', Buffer.alloc(0)],
    ['truncated', tinyJpeg().subarray(0, 50)]
  ])('degrades a %s file to placeholder + sidecar and never retries on cache hit', async (_name, broken) => {
    const { thumbDir, previewDir } = roots()
    const source = await writeSource('broken.jpg', broken)
    const out = path.join(previewDir, '42.jpg')

    const first = await ensurePreview(photo({ absPath: source }), { thumbDir, previewDir })
    expect(first).toEqual({ path: out, placeholder: true })
    expect(fs.readFileSync(out)).toEqual(PLACEHOLDER_JPEG_BYTES)
    expect(fs.existsSync(`${out}.placeholder`)).toBe(true)

    const mtime = fs.statSync(out).mtimeMs
    const second = await ensurePreview(photo({ absPath: source }), { thumbDir, previewDir })
    expect(second.placeholder).toBe(true)
    expect(fs.statSync(out).mtimeMs).toBe(mtime)
  })

  it('short-circuits a missing=1 photo to placeholder without reading the source', async () => {
    const { thumbDir, previewDir } = roots()
    const result = await ensurePreview(photo({ missing: 1 }), { thumbDir, previewDir })
    expect(result.placeholder).toBe(true)
    expect(fs.existsSync(`${path.join(previewDir, '42.jpg')}.placeholder`)).toBe(true)
  })

  it('wraps a RAW extraction rejection into placeholder + sidecar', async () => {
    const { thumbDir, previewDir } = roots()
    const result = await ensurePreview(
      photo({ ext: '.arw' }),
      { thumbDir, previewDir },
      {
        previewDir,
        reader: {
          ensureRawPreview: async () => {
            throw new RawPreviewError('no embedded preview')
          },
          readImageMeta: async () => ({ orientation: 1, width: 1, height: 1 })
        }
      }
    )
    expect(result.placeholder).toBe(true)
    expect(fs.existsSync(`${path.join(previewDir, '42.jpg')}.placeholder`)).toBe(true)
  })
})
