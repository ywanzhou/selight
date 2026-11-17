import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import type { MediaKind } from '../shared/api'

export interface MediaRoots {
  thumbDir: string
  previewDir: string
}

// Discriminated result so the protocol layer can distinguish a security
// rejection (403, no enqueue) from a cache miss the thumbnail queue should
// fill on demand (404 + enqueue + media-ready notification).
export type ResolveResult =
  | { ok: true; file: string }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'not-generated'; id: number }

function parseId(photoId: number | string): number | null {
  if (typeof photoId === 'number') {
    return Number.isInteger(photoId) && photoId > 0 ? photoId : null
  }
  if (!/^\d+$/.test(photoId)) return null
  const id = Number(photoId)
  return id > 0 ? id : null
}

interface PhotoRecord {
  id: number
  abs_path: string
  ext: string
  missing: number
}

export function resolveMediaPath(
  db: Database,
  roots: MediaRoots,
  kind: MediaKind,
  photoId: number | string
): ResolveResult {
  const id = parseId(photoId)
  if (id === null) return { ok: false, reason: 'forbidden' }
  if (kind !== 'thumb' && kind !== 'photo') {
    return { ok: false, reason: 'forbidden' }
  }

  const row = db
    .prepare('SELECT id, abs_path, ext, missing FROM photos WHERE id = ?')
    .get(id) as PhotoRecord | undefined
  if (row === undefined || row.missing === 1) {
    return { ok: false, reason: 'forbidden' }
  }

  if (kind === 'thumb') {
    const candidate = path.resolve(roots.thumbDir, `${id}.jpg`)
    // Containment: the numeric id can only ever address a file directly in thumbDir.
    if (!candidate.startsWith(path.resolve(roots.thumbDir) + path.sep)) {
      return { ok: false, reason: 'forbidden' }
    }
    return fs.existsSync(candidate)
      ? { ok: true, file: candidate }
      : { ok: false, reason: 'not-generated', id }
  }

  // Both RAW and direct formats serve only the generated 2048px preview: the
  // read-only source bytes must never reach the renderer (phase 3 invariant).
  const candidate = path.resolve(roots.previewDir, `${id}.jpg`)
  if (!candidate.startsWith(path.resolve(roots.previewDir) + path.sep)) {
    return { ok: false, reason: 'forbidden' }
  }
  return fs.existsSync(candidate)
    ? { ok: true, file: candidate }
    : { ok: false, reason: 'not-generated', id }
}
