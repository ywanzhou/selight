import fs from 'node:fs/promises'
import path from 'node:path'
import { exiftool } from 'exiftool-vendored'
import type { ExifReader } from '../scanner'
import { rotateJpegBuffer } from './orientation'

export class RawPreviewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RawPreviewError'
  }
}

// Minimal structural surface of exiftool-vendored's ExifTool that we use.
// read() returns BinaryField placeholders rather than bytes for binary tags,
// so embedded JPEGs go through extractBinaryTagToBuffer (rejects when absent).
export interface ExifToolLike {
  read(file: string): Promise<{ Orientation?: number }>
  extractBinaryTagToBuffer(
    tag: 'ThumbnailImage' | 'PreviewImage',
    file: string
  ): Promise<Buffer>
}

const KNOWN_ORIENTATIONS = new Set([1, 3, 6, 8])

export class ExiftoolReader implements ExifReader {
  constructor(private readonly exif: ExifToolLike = exiftool) {}

  async readOrientation(absPath: string, _ext: string): Promise<number> {
    const { Orientation } = await this.exif.read(absPath)
    return Orientation !== undefined && KNOWN_ORIENTATIONS.has(Orientation) ? Orientation : 1
  }

  async extractPreview(absPath: string): Promise<Buffer> {
    try {
      return await this.exif.extractBinaryTagToBuffer('ThumbnailImage', absPath)
    } catch {
      try {
        return await this.exif.extractBinaryTagToBuffer('PreviewImage', absPath)
      } catch (cause) {
        throw new RawPreviewError(`No embedded preview found in ${absPath}`, { cause })
      }
    }
  }

  async ensureRawPreview(
    photo: { id: number; absPath: string; orientation: number },
    cacheDir: string
  ): Promise<string> {
    const out = path.join(cacheDir, `${photo.id}.jpg`)
    try {
      await fs.access(out)
      return out
    } catch {
      // Not cached yet: fall through to extraction.
    }

    const extracted = await this.extractPreview(photo.absPath)
    const rotated = await rotateJpegBuffer(extracted, photo.orientation)
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(out, rotated)
    return out
  }
}
