import { nativeImage, type NativeImage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import type { PhotoRow } from '../domain/photos'
import { ExiftoolReader } from './rawPreview'
import { rotateJpegBuffer } from './orientation'
import { RAW_EXTENSIONS } from './formats'
import { MediaQueue } from './queue'

const THUMB_WIDTH = 320
const JPEG_QUALITY = 85

// Smallest structural surface ensureThumbnail needs; a full PhotoRow is assignable to it.
export type ThumbnailPhoto = Pick<
  PhotoRow,
  'id' | 'absPath' | 'ext' | 'orientation' | 'missing'
>

export interface ThumbnailDeps {
  /** Cache dir for RAW extracted previews (previews/<id>.jpg). */
  previewDir: string
  /** Injection point for tests and alternate ExifTool transports. */
  reader?: Pick<ExiftoolReader, 'ensureRawPreview'>
}

export interface ThumbnailResult {
  path: string
  placeholder: boolean
}

// Tiny real 8x4 JPEG inlined as the placeholder source so a degraded thumbnail
// is still a valid image the renderer can display.
const PLACEHOLDER_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAQACAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOC+Jz6N8IPjR+1t8NvhP4V8P/Df4f8Awm+J37HHj34ZeC/CC6vpXhjwL4q+M/w3+BGveOLzw1oo1eTT9N0b+0vjF8SX8K+CooP+ED8CWviVNM8FeF9B0zw/4Vs9C+w8M+Ecu8V8N4DS4mqclXxGxfFv0eeLsTg8p4YxGMzTgLijwy458TctrSxue5DnWLp8QeHviB4Y8O8X+G+YQrLC8L59ic7x8MvxdXNarhpwBhocJ/TRyvKsjf1XL+KuH/EHLs/w0qdCtHMMty3hfMuJaWA56tGVTB0q+dcP5JisZWwE8LjcTTy2lgZ4r+z6+NwuK//Z'

// Write via a sibling .tmp then rename so a crash cannot leave a truncated
// thumbnail that cache-hits forever.
async function atomicWrite(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

async function fallbackPlaceholder(
  out: string,
  photoId: number,
  cause: unknown
): Promise<ThumbnailResult> {
  console.error(`[selight] thumbnail generation failed for photo ${photoId}`, cause)
  await atomicWrite(out, Buffer.from(PLACEHOLDER_JPEG_BASE64, 'base64'))
  return { path: out, placeholder: true }
}

export async function ensureThumbnail(
  photo: ThumbnailPhoto,
  cacheDir: string,
  deps?: ThumbnailDeps
): Promise<ThumbnailResult> {
  const out = path.join(cacheDir, `${photo.id}.jpg`)
  try {
    await fs.access(out)
    return { path: out, placeholder: false }
  } catch {
    // Cache miss: generate below.
  }

  if (photo.missing === 1) {
    return fallbackPlaceholder(out, photo.id, new Error(`photo ${photo.id} is marked missing`))
  }

  try {
    const ext = photo.ext.toLowerCase()
    let image: NativeImage

    if (RAW_EXTENSIONS.has(ext)) {
      if (!deps?.previewDir) {
        throw new Error('previewDir is required to build RAW thumbnails')
      }
      const reader = deps.reader ?? new ExiftoolReader()
      const preview = await reader.ensureRawPreview(photo, deps.previewDir)
      image = nativeImage.createFromBuffer(await fs.readFile(preview))
    } else if ((ext === '.jpg' || ext === '.jpeg') && photo.orientation !== 1) {
      // createThumbnail ignores EXIF orientation, so rotate the JPEG bytes first.
      const rotated = await rotateJpegBuffer(await fs.readFile(photo.absPath), photo.orientation)
      image = nativeImage.createFromBuffer(rotated)
    } else {
      // Electron 44's API: scales to fit inside the Size while preserving aspect ratio.
      image = await nativeImage.createThumbnailFromPath(photo.absPath, {
        width: THUMB_WIDTH,
        height: THUMB_WIDTH
      })
    }

    const resized = image.resize({ width: THUMB_WIDTH })
    if (resized.isEmpty()) {
      throw new Error(`nativeImage decoded an empty image for ${photo.absPath}`)
    }
    await atomicWrite(out, resized.toJPEG(JPEG_QUALITY))
    return { path: out, placeholder: false }
  } catch (err) {
    // Any failure — RawPreviewError, jpeg-js rotation error, fs SystemError — degrades
    // to a placeholder instead of breaking the queue or the renderer.
    return fallbackPlaceholder(out, photo.id, err)
  }
}

export interface ThumbnailRoots {
  thumbDir: string
  previewDir: string
}

// Wires the queue to the photos DB: the worker loads the row and builds its thumbnail.
// The returned MediaQueue is what Task 11 calls enqueue/prioritize on.
export function createThumbnailQueue(
  db: Database,
  roots: ThumbnailRoots,
  reader?: Pick<ExiftoolReader, 'ensureRawPreview'>
): MediaQueue {
  return new MediaQueue(async (id) => {
    const row = db
      .prepare(
        'SELECT id, abs_path AS absPath, ext, orientation, missing FROM photos WHERE id = ?'
      )
      .get(id) as ThumbnailPhoto | undefined
    if (row === undefined) return
    await ensureThumbnail(row, roots.thumbDir, { previewDir: roots.previewDir, reader })
  })
}
