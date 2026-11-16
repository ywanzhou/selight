import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Electron is unavailable under bare-node Vitest (the package exports its executable
// path string). Mock just the nativeImage surface ensureThumbnail uses.
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn(),
    createThumbnailFromPath: vi.fn()
  }
}))

// The Blink helper is an Electron shell: node tests exercise its contract via the pure
// blinkProtocol suite and the committed Electron harness; here its boundary is mocked.
vi.mock('../../electron/media/blinkThumbnail', () => ({
  decodeWebpThumbnail: vi.fn(),
  configureBlinkThumbnail: vi.fn(),
  closeBlinkHelper: vi.fn()
}))

// Import after the mocks are registered.
import { nativeImage } from 'electron'
import { decodeWebpThumbnail } from '../../electron/media/blinkThumbnail'
import { ensureThumbnail, type ThumbnailPhoto } from '../../electron/media/thumbnails'
import { RawPreviewError } from '../../electron/media/rawPreview'
import { tinyJpeg } from './fixtures'

const dirs: string[] = []
const mocked = vi.mocked(nativeImage)
const mockedBlink = vi.mocked(decodeWebpThumbnail)

function makeCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-thumb-'))
  dirs.push(dir)
  return dir
}

function fakeImage(): {
  isEmpty: () => boolean
  resize: ReturnType<typeof vi.fn>
} {
  return {
    isEmpty: () => false,
    resize: vi.fn(() => ({
      isEmpty: () => false,
      toJPEG: () => tinyJpeg()
    }))
  }
}

function photo(overrides: Partial<ThumbnailPhoto> = {}): ThumbnailPhoto {
  return {
    id: 42,
    absPath: path.join(os.tmpdir(), 'selight-nonexistent-source.jpg'),
    ext: '.jpg',
    orientation: 1,
    missing: 0,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('ensureThumbnail placeholder sidecar', () => {
  it('marks a missing photo with a persistent sidecar and keeps placeholder:true on cache hit', async () => {
    const cacheDir = makeCacheDir()
    const p = photo({ missing: 1 })
    const out = path.join(cacheDir, '42.jpg')
    const marker = `${out}.placeholder`

    const first = await ensureThumbnail(p, cacheDir)
    expect(first).toEqual({ path: out, placeholder: true })
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.existsSync(marker)).toBe(true)
    expect(mocked.createThumbnailFromPath).not.toHaveBeenCalled()

    // Restart-equivalent: nothing in memory, only the files on disk.
    const second = await ensureThumbnail(p, cacheDir)
    expect(second).toEqual({ path: out, placeholder: true })
  })

  it('writes the sidecar when decoding fails and still reports placeholder:true after a cache hit', async () => {
    const cacheDir = makeCacheDir()
    mocked.createThumbnailFromPath.mockRejectedValue(new Error('decode boom'))
    const p = photo()
    const marker = path.join(cacheDir, '42.jpg.placeholder')

    const first = await ensureThumbnail(p, cacheDir)
    expect(first.placeholder).toBe(true)
    expect(fs.existsSync(marker)).toBe(true)

    const second = await ensureThumbnail(p, cacheDir)
    expect(second.placeholder).toBe(true)
    // Cache hit must not retry the failing decoder.
    expect(mocked.createThumbnailFromPath).toHaveBeenCalledTimes(1)
  })

  it('wraps a RAW RawPreviewError into a placeholder with sidecar', async () => {
    const cacheDir = makeCacheDir()
    const previewDir = makeCacheDir()
    const p = photo({ ext: '.arw' })
    const marker = path.join(cacheDir, '42.jpg.placeholder')

    const result = await ensureThumbnail(p, cacheDir, {
      previewDir,
      reader: {
        ensureRawPreview: async () => {
          throw new RawPreviewError('no embedded preview')
        }
      }
    })
    expect(result.placeholder).toBe(true)
    expect(fs.existsSync(marker)).toBe(true)
  })

  it('writes no sidecar on success and reports placeholder:false on cache hit', async () => {
    const cacheDir = makeCacheDir()
    mocked.createThumbnailFromPath.mockResolvedValue(fakeImage() as never)
    const p = photo()
    const out = path.join(cacheDir, '42.jpg')
    const marker = `${out}.placeholder`

    const first = await ensureThumbnail(p, cacheDir)
    expect(first).toEqual({ path: out, placeholder: false })
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
    // Real JPEG magic, not the placeholder.
    expect(fs.readFileSync(out).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))

    const second = await ensureThumbnail(p, cacheDir)
    expect(second).toEqual({ path: out, placeholder: false })
    expect(mocked.createThumbnailFromPath).toHaveBeenCalledTimes(1)
  })

  it('routes webp through the Blink helper and writes its JPEG without touching nativeImage', async () => {
    const cacheDir = makeCacheDir()
    const jpeg = tinyJpeg()
    mockedBlink.mockResolvedValue(jpeg)
    const p = photo({ ext: '.webp', absPath: path.join(os.tmpdir(), 'selight-source.webp') })
    const out = path.join(cacheDir, '42.jpg')

    const result = await ensureThumbnail(p, cacheDir)

    expect(result).toEqual({ path: out, placeholder: false })
    expect(mockedBlink).toHaveBeenCalledWith(p.absPath)
    expect(fs.readFileSync(out)).toEqual(jpeg)
    expect(fs.existsSync(`${out}.placeholder`)).toBe(false)
    expect(mocked.createThumbnailFromPath).not.toHaveBeenCalled()
    expect(mocked.createFromBuffer).not.toHaveBeenCalled()
  })

  it('degrades a Blink webp failure to the placeholder with sidecar, keeping the queue contract', async () => {
    const cacheDir = makeCacheDir()
    mockedBlink.mockRejectedValue(new Error('helper unavailable'))
    const p = photo({ ext: '.webp', absPath: path.join(os.tmpdir(), 'selight-source.webp') })
    const out = path.join(cacheDir, '42.jpg')

    const result = await ensureThumbnail(p, cacheDir)

    expect(result).toEqual({ path: out, placeholder: true })
    expect(fs.existsSync(`${out}.placeholder`)).toBe(true)
    expect(mocked.createThumbnailFromPath).not.toHaveBeenCalled()
  })

  it('removes a stale sidecar when a later generation succeeds', async () => {
    const cacheDir = makeCacheDir()
    const out = path.join(cacheDir, '42.jpg')
    fs.writeFileSync(`${out}.placeholder`, '')
    mocked.createThumbnailFromPath.mockResolvedValue(fakeImage() as never)

    const result = await ensureThumbnail(photo(), cacheDir)
    expect(result.placeholder).toBe(false)
    expect(fs.existsSync(`${out}.placeholder`)).toBe(false)
  })
})
