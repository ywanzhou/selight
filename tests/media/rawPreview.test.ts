import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  thumbnail?: Buffer | (() => Buffer)
  preview?: Buffer | (() => Buffer)
}) {
  const read = vi.fn(async (_file: string) => ({ Orientation: handlers.orientation }))
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
    const source = tinyJpeg()
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
    // Orientation 6 must go through rotateJpegBuffer: cached bytes differ from
    // the extracted source buffer.
    expect(written.equals(source)).toBe(false)
    expect(fake.extract).toHaveBeenCalledTimes(1)

    const cached = await reader.ensureRawPreview(photo, cacheDir)
    expect(cached).toBe(expected)
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
