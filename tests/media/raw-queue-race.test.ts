import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { ExiftoolReader } from '../../electron/media/rawPreview'
import { ensurePreview, PLACEHOLDER_JPEG_BYTES } from '../../electron/media/previews'
import { ensureThumbnail } from '../../electron/media/thumbnails'
import type { ThumbnailPhoto, ThumbnailRoots } from '../../electron/media/thumbnails'

const dirs: string[] = []

function makeCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-race-'))
  dirs.push(dir)
  return dir
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

// Regression for the cross-queue RAW race: the thumbnail backfill and the
// on-demand preview queue share one ExiftoolReader (main.ts wiring). Both
// extracted the same ARW into previews/<id>.jpg through the same .tmp path;
// one rename stole the other's tmp, and ensurePreview caught the ENOENT and
// permanently replaced the 2048 preview with an 8x4 placeholder.
describe('RAW thumbnail/preview cross-queue concurrency', () => {
  it('never degrades the preview to a placeholder across repeated concurrent builds', async () => {
    // 2400px long edge: larger than the 2048 preview cap so a real encode is
    // observable. A cache-hit short-circuit would leave the 2400px embedded
    // bytes untouched and fail the 2048 assertion below.
    const embedded = await sharp({
      create: {
        width: 2400,
        height: 1600,
        channels: 3,
        background: { r: 10, g: 20, b: 30, alpha: 1 }
      }
    })
      .jpeg()
      .toBuffer()

    const extract = vi.fn(async () => embedded)
    const reader = new ExiftoolReader({
      read: vi.fn(async () => ({ Orientation: 1, ImageWidth: 6000, ImageHeight: 4000 })),
      extractBinaryTagToBuffer: extract
    })

    const rounds = 25
    for (let round = 0; round < rounds; round += 1) {
      const previewDir = makeCacheDir()
      const thumbDir = makeCacheDir()
      const roots: ThumbnailRoots = { thumbDir, previewDir }
      const photo: ThumbnailPhoto = {
        id: 42,
        absPath: path.join(previewDir, 'shot.arw'),
        ext: '.arw',
        orientation: 1,
        width: 6000,
        missing: 0
      }

      await Promise.all([
        ensurePreview(photo, roots, { previewDir, reader }),
        ensureThumbnail(photo, thumbDir, { previewDir, reader })
      ])

      const previewOut = path.join(previewDir, '42.jpg')
      expect(fs.existsSync(previewOut)).toBe(true)
      expect(fs.readFileSync(previewOut).equals(PLACEHOLDER_JPEG_BYTES)).toBe(false)
      expect(fs.existsSync(`${previewOut}.placeholder`)).toBe(false)
      const meta = await sharp(previewOut).metadata()
      expect(Math.max(meta.width!, meta.height!)).toBe(2048)

      const thumbOut = path.join(thumbDir, '42.jpg')
      expect(fs.existsSync(thumbOut)).toBe(true)
      expect(fs.readFileSync(thumbOut).equals(PLACEHOLDER_JPEG_BYTES)).toBe(false)
    }

    // In-flight de-dupe: both queues await one extraction per round instead of
    // each spawning their own exiftool extraction.
    expect(extract).toHaveBeenCalledTimes(rounds)
  })
})
