import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { ExiftoolReader, RawPreviewError } from '../../electron/media/rawPreview'
import { tinyJpeg } from './fixtures'

const dirs: string[] = []

function makeCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-t9-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function makeFake(handlers: {
  orientation?: number
  imageWidth?: number
  imageHeight?: number
  thumbnail?: Buffer | (() => Buffer)
  preview?: Buffer | (() => Buffer)
}) {
  const read = vi.fn(async (_file: string) => ({
    Orientation: handlers.orientation,
    ImageWidth: handlers.imageWidth,
    ImageHeight: handlers.imageHeight
  }))
  const extract = vi.fn(async (tag: 'ThumbnailImage' | 'PreviewImage', _file: string) => {
    if (tag === 'ThumbnailImage') {
      if (handlers.thumbnail === undefined) throw new Error('no thumbnail')
      return typeof handlers.thumbnail === 'function' ? handlers.thumbnail() : handlers.thumbnail
    }
    if (handlers.preview === undefined) throw new Error('no preview')
    return typeof handlers.preview === 'function' ? handlers.preview() : handlers.preview
  })
  return { read, extract }
}

describe('ExiftoolReader.readOrientation', () => {
  const cases: Array<[number, number]> = [
    [1, 1],
    [3, 3],
    [6, 6],
    [8, 8],
    [9, 1]
  ]
  for (const [tag, expected] of cases) {
    it(`maps exiftool Orientation ${tag} -> ${expected}`, async () => {
      const fake = makeFake({ orientation: tag })
      const reader = new ExiftoolReader({
        read: fake.read,
        extractBinaryTagToBuffer: fake.extract
      })
      await expect(reader.readOrientation('x.arw', '.arw')).resolves.toBe(expected)
    })
  }

  it('defaults to 1 when the Orientation tag is missing', async () => {
    const fake = makeFake({})
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(reader.readOrientation('x.arw', '.arw')).resolves.toBe(1)
  })
})

describe('ExiftoolReader.readImageMeta', () => {
  it('maps orientation and dimensions through, defaulting orientation to 1', async () => {
    const fake = makeFake({ orientation: 6, imageWidth: 6000, imageHeight: 4000 })
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(reader.readImageMeta('x.arw', '.arw')).resolves.toEqual({
      orientation: 6,
      width: 6000,
      height: 4000
    })
  })

  it('falls back to orientation 1 and null dimensions when tags are absent', async () => {
    const fake = makeFake({})
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(reader.readImageMeta('x.arw', '.arw')).resolves.toEqual({
      orientation: 1,
      width: null,
      height: null
    })
  })

  it('rejects unknown orientation values while keeping whatever dimensions exist', async () => {
    const fake = makeFake({ orientation: 9, imageWidth: 120 })
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(reader.readImageMeta('x.arw', '.arw')).resolves.toEqual({
      orientation: 1,
      width: 120,
      height: null
    })
  })
})

describe('ExiftoolReader.extractPreview', () => {
  it('prefers ThumbnailImage and never touches PreviewImage', async () => {
    const thumb = tinyJpeg()
    const preview = Buffer.from([1, 2, 3])
    const fake = makeFake({ thumbnail: thumb, preview })
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(reader.extractPreview('x.arw')).resolves.toBe(thumb)
    expect(fake.extract).toHaveBeenCalledTimes(1)
    expect(fake.extract).toHaveBeenCalledWith('ThumbnailImage', 'x.arw')
  })

  it('falls back to PreviewImage when no thumbnail exists', async () => {
    const preview = tinyJpeg()
    const fake = makeFake({ preview })
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(reader.extractPreview('x.arw')).resolves.toBe(preview)
    expect(fake.extract).toHaveBeenCalledTimes(2)
    expect(fake.extract).toHaveBeenLastCalledWith('PreviewImage', 'x.arw')
  })

  it('throws RawPreviewError when neither embedded image exists', async () => {
    const fake = makeFake({})
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(reader.extractPreview('x.arw')).rejects.toBeInstanceOf(RawPreviewError)
  })
})

describe('ExiftoolReader.ensureRawPreview', () => {
  it('extracts once, rotates by orientation, caches, and serves the second call from cache', async () => {
    const cacheDir = makeCacheDir()
    // 640x480 landscape buffer: after the 90deg orientation-6 rotation the
    // cached JPEG frame must physically decode as 480x640 (width < height).
    const source = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 10, g: 20, b: 30, alpha: 1 }
      }
    })
      .jpeg()
      .toBuffer()
    const fake = makeFake({ orientation: 6, thumbnail: () => source })
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    const photo = { id: 7, absPath: 'x.arw', orientation: 6 }

    const out = await reader.ensureRawPreview(photo, cacheDir)
    const expected = path.join(cacheDir, '7.jpg')
    expect(out).toBe(expected)
    expect(fs.existsSync(expected)).toBe(true)
    const written = fs.readFileSync(expected)
    expect(written.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    const meta = await sharp(written).metadata()
    expect(meta.width).toBeLessThan(meta.height!)
    // Rotation is a real re-encode: it must not silently use sharp's default
    // quality 80 (the legacy jpeg-autorotate path encoded at quality 100).
    // Same-version sharp with identical inputs is deterministic, so the q80
    // reference is byte-stable.
    const q80Reference = await sharp(source).rotate(90).jpeg().toBuffer()
    expect(written.equals(q80Reference)).toBe(false)
    expect(fake.extract).toHaveBeenCalledTimes(1)

    const cached = await reader.ensureRawPreview(photo, cacheDir)
    expect(cached).toBe(expected)
    expect(fake.extract).toHaveBeenCalledTimes(1)
  })

  it('writes the extracted bytes untouched when orientation needs no rotation', async () => {
    const cacheDir = makeCacheDir()
    // angle 0 must be a lossless passthrough: the embedded JPEG is the camera's
    // own preview and a second JPEG encode would only add generation loss.
    const source = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 10, g: 20, b: 30, alpha: 1 }
      }
    })
      .jpeg()
      .toBuffer()
    const fake = makeFake({ orientation: 1, thumbnail: () => source })
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })

    const out = await reader.ensureRawPreview(
      { id: 9, absPath: 'x.arw', orientation: 1 },
      cacheDir
    )
    expect(fs.readFileSync(out)).toEqual(source)
    expect(fake.extract).toHaveBeenCalledTimes(1)
  })

  it('wraps extraction failure as RawPreviewError', async () => {
    const cacheDir = makeCacheDir()
    const fake = makeFake({})
    const reader = new ExiftoolReader({
      read: fake.read,
      extractBinaryTagToBuffer: fake.extract
    })
    await expect(
      reader.ensureRawPreview({ id: 8, absPath: 'x.arw', orientation: 6 }, cacheDir)
    ).rejects.toBeInstanceOf(RawPreviewError)
  })
})
