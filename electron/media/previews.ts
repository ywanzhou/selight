import fs from 'node:fs/promises'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import sharp from 'sharp'
import { RAW_EXTENSIONS } from './formats'
import { MediaQueue } from './queue'
import {
  PLACEHOLDER_JPEG_BYTES as PLACEHOLDER_BYTES,
  type ThumbnailDeps,
  type ThumbnailPhoto,
  type ThumbnailReader,
  type ThumbnailRoots
} from './thumbnails'
import { ExiftoolReader } from './rawPreview'
import { enrichPhoto } from './enrich'

// Preview cache uses the same structural row shape as the thumbnail pipeline.
export type PreviewPhoto = ThumbnailPhoto
export type { ThumbnailDeps, ThumbnailRoots, ThumbnailReader }
// Same 8x4 placeholder JPEG serves both caches.
export const PLACEHOLDER_JPEG_BYTES = PLACEHOLDER_BYTES

sharp.concurrency(1)
sharp.cache({ files: 0 })

const PREVIEW_LONG_EDGE = 2048
const JPEG_QUALITY = 85

export interface PreviewResult {
  path: string
  placeholder: boolean
}

async function atomicWrite(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

function markerPath(file: string): string {
  return `${file}.placeholder`
}

async function writeMarker(file: string): Promise<void> {
  await fs.writeFile(markerPath(file), '')
}

async function removeMarker(file: string): Promise<void> {
  await fs.rm(markerPath(file), { force: true })
}

async function hasMarker(file: string): Promise<boolean> {
  try {
    await fs.access(markerPath(file))
    return true
  } catch {
    return false
  }
}

async function fallbackPlaceholder(
  out: string,
  photoId: number,
  cause: unknown
): Promise<PreviewResult> {
  console.error(`[selight] preview generation failed for photo ${photoId}`, cause)
  await atomicWrite(out, PLACEHOLDER_JPEG_BYTES)
  await writeMarker(out)
  return { path: out, placeholder: true }
}

// 2048px-inside JPEG; shrink-on-load keeps the full-resolution RGBA buffer
// out of memory even for 60+ megapixel camera files.
function encodePreview(input: string | Buffer): Promise<Buffer> {
  return sharp(input, { failOn: 'none' })
    .rotate()
    .resize(PREVIEW_LONG_EDGE, PREVIEW_LONG_EDGE, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()
}

// Builds the screen-size preview at previews/<id>.jpg. Direct formats read the
// source through libvips; RAW reuses the extracted/rotated embedded preview.
export async function ensurePreview(
  photo: PreviewPhoto,
  roots: ThumbnailRoots,
  deps?: ThumbnailDeps
): Promise<PreviewResult> {
  const out = path.join(roots.previewDir, `${photo.id}.jpg`)
  try {
    await fs.access(out)
    return { path: out, placeholder: await hasMarker(out) }
  } catch {
    // Cache miss: generate below.
  }

  if (photo.missing === 1) {
    return fallbackPlaceholder(out, photo.id, new Error(`photo ${photo.id} is marked missing`))
  }

  try {
    const ext = photo.ext.toLowerCase()
    let bytes: Buffer

    if (RAW_EXTENSIONS.has(ext)) {
      if (!deps?.previewDir) {
        throw new Error('previewDir is required to build RAW previews')
      }
      const reader = deps.reader ?? new ExiftoolReader()
      const embedded = await reader.ensureRawPreview(photo, deps.previewDir)
      bytes = await encodePreview(await fs.readFile(embedded))
    } else {
      bytes = await encodePreview(photo.absPath)
    }

    await atomicWrite(out, bytes)
    await removeMarker(out)
    return { path: out, placeholder: false }
  } catch (err) {
    return fallbackPlaceholder(out, photo.id, err)
  }
}

// Queue for the preview (photo route) workload, kept separate from the
// high-frequency thumbnail queue so a full-screen preview cannot starve grid
// scrolling of workers.
export function createPreviewQueue(
  db: Database,
  roots: ThumbnailRoots,
  reader?: ThumbnailReader,
  onReady?: (id: number, ok: boolean) => void
): MediaQueue {
  return new MediaQueue(async (id) => {
    const row = db
      .prepare(
        'SELECT id, abs_path AS absPath, ext, orientation, width, missing FROM photos WHERE id = ?'
      )
      .get(id) as PreviewPhoto | undefined
    if (row === undefined) return

    if (RAW_EXTENSIONS.has(row.ext.toLowerCase()) && row.width === null && reader) {
      await enrichPhoto(db, id, reader)
      const healed = db
        .prepare('SELECT orientation, width FROM photos WHERE id = ?')
        .get(id) as { orientation: number; width: number | null } | undefined
      if (healed === undefined || healed.width === null) {
        const result = await ensurePreview(
          { ...row, missing: 1 },
          roots,
          { previewDir: roots.previewDir, reader }
        )
        onReady?.(id, result.placeholder === false)
        return
      }
      row.orientation = healed.orientation
      row.width = healed.width
    }

    const result = await ensurePreview(row, roots, {
      previewDir: roots.previewDir,
      reader
    })
    onReady?.(id, result.placeholder === false)
  })
}
