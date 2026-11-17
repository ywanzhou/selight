import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import { orientationToRotate } from './orientation'

export interface ImageMeta {
  orientation: number
  width: number | null
  height: number | null
}

// Metadata reader contract, injected into enrichment and the thumbnail queue.
// Lives next to its production ExiftoolReader instead of the fs-only scanner.
export interface ExifReader {
  readOrientation(absPath: string, ext: string): Promise<number>
  readImageMeta(absPath: string, ext: string): Promise<ImageMeta>
}

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
  read(file: string): Promise<{
    Orientation?: number
    ImageWidth?: number
    ImageHeight?: number
  }>
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

  async readImageMeta(absPath: string, _ext: string): Promise<ImageMeta> {
    const tags = await this.exif.read(absPath)
    const orientation =
      tags.Orientation !== undefined && KNOWN_ORIENTATIONS.has(tags.Orientation)
        ? tags.Orientation
        : 1
    return {
      orientation,
      width: typeof tags.ImageWidth === 'number' ? tags.ImageWidth : null,
      height: typeof tags.ImageHeight === 'number' ? tags.ImageHeight : null
    }
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
    // Embedded previews carry no EXIF orientation tag: the source ARW's
    // orientation drives an explicit sharp rotation. angle 0 is a lossless
    // passthrough — never re-encode the camera's own preview; rotated frames
    // use quality 100 to match the legacy jpeg-autorotate setting.
    const angle = orientationToRotate(photo.orientation)
    const rotated =
      angle === 0
        ? extracted
        : await sharp(extracted).rotate(angle).jpeg({ quality: 100 }).toBuffer()
    await fs.mkdir(cacheDir, { recursive: true })
    // Sibling .tmp + rename: a crash mid-write cannot leave a truncated preview
    // that the access()-based cache check above would serve forever.
    const tmp = `${out}.tmp`
    await fs.writeFile(tmp, rotated)
    await fs.rename(tmp, out)
    return out
  }
}
