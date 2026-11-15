import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { RAW_EXTENSIONS } from './formats'

export interface MediaRoots {
  thumbDir: string
  previewDir: string
}

export type MediaKind = 'thumb' | 'photo'

interface PhotoRecord {
  abs_path: string
  ext: string
  missing: number
}

// Integers or digit-only strings only. Anything containing '/', '..', '\' or
// other punctuation is rejected before it ever touches the filesystem.
function parseId(photoId: number | string): number | null {
  if (typeof photoId === 'number') {
    return Number.isInteger(photoId) && photoId > 0 ? photoId : null
  }
  if (!/^\d+$/.test(photoId)) return null
  const id = Number(photoId)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

// True when candidate is root itself or a path beneath it; a '..' escape or an
// absolute different drive resolves to a path.relative() starting with '..'.
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function resolveMediaPath(
  db: Database,
  roots: MediaRoots,
  kind: MediaKind,
  photoId: number | string
): string | null {
  const id = parseId(photoId)
  if (id === null) return null

  const thumbDir = path.resolve(roots.thumbDir)
  const previewDir = path.resolve(roots.previewDir)

  const row = db
    .prepare('SELECT abs_path, ext, missing FROM photos WHERE id = ?')
    .get(id) as PhotoRecord | undefined
  if (row === undefined || row.missing === 1) return null

  if (kind === 'thumb') {
    // Thumbnails are normalized JPEGs keyed by photo id; containment plus a
    // registered, present row is the whole authorization rule.
    const candidate = path.resolve(thumbDir, `${id}.jpg`)
    return isInside(thumbDir, candidate) && fs.existsSync(candidate) ? candidate : null
  }
  if (kind !== 'photo') return null

  if (RAW_EXTENSIONS.has(row.ext.toLowerCase())) {
    // RAW sources are never served directly: only the extracted preview cache.
    const candidate = path.resolve(previewDir, `${id}.jpg`)
    return isInside(previewDir, candidate) && fs.existsSync(candidate) ? candidate : null
  }

  // Direct-format source files may live anywhere, but the id must resolve to a
  // registered, present row — arbitrary caller-supplied paths never reach here.
  const candidate = path.resolve(row.abs_path)
  return fs.existsSync(candidate) ? candidate : null
}
