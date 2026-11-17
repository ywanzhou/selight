import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { markMissing, upsertPhoto } from './domain/photos'

export interface ScannedFile {
  absPath: string
  filename: string
  ext: string
  sizeBytes: number
  mtime: number
}

// Direct-read formats and RAW containers from the design spec; matched case-insensitively.
const SUPPORTED_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.arw',
  '.cr2',
  '.cr3',
  '.nef',
  '.dng',
  '.raf',
  '.rw2',
  '.orf',
  '.pef',
  '.srw'
])

// Bound-variable safety margin below SQLite's 32766 limit for the missing-reset IN clause.
const RESET_CHUNK = 500

export interface ScanResult {
  files: ScannedFile[]
  /** Paths skipped because a directory or file could not be read (Ruling 15). */
  failures: string[]
}

// Discovery is deliberately fs-only: readdir + stat + extension filtering.
// EXIF orientation and pixel dimensions are enriched later in the background so
// a large import returns in seconds instead of paying one exiftool round trip
// per file on the critical path.
export async function scanDirectory(root: string): Promise<ScanResult> {
  const files: ScannedFile[] = []
  const failures: string[] = []
  await walk(root, files, failures)
  return { files, failures }
}

async function walk(
  dir: string,
  out: ScannedFile[],
  failures: string[]
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    // Unreadable or missing directory: record it and skip instead of aborting the scan.
    failures.push(dir)
    return
  }

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(absPath, out, failures)
      continue
    }
    if (!entry.isFile()) continue

    const ext = path.extname(entry.name).toLowerCase()
    if (!SUPPORTED_EXT.has(ext)) continue

    let stats: fs.Stats
    try {
      stats = await fs.promises.stat(absPath)
    } catch {
      // Unreadable file: record the skipped path and keep scanning.
      failures.push(absPath)
      continue
    }

    out.push({
      absPath,
      filename: entry.name,
      ext,
      sizeBytes: stats.size,
      mtime: Math.round(stats.mtimeMs)
    })
  }
}

export function importScanned(
  db: Database,
  batchId: number,
  sourceId: number,
  files: ScannedFile[]
): { added: number; updated: number; missing: number } {
  return db.transaction(() => {
    let added = 0
    let updated = 0
    const presentPaths: string[] = []

    for (const file of files) {
      const { created } = upsertPhoto(db, {
        batchId,
        sourceId,
        absPath: file.absPath,
        filename: file.filename,
        ext: file.ext,
        sizeBytes: file.sizeBytes,
        mtime: file.mtime
      })
      if (created) added += 1
      else updated += 1
      presentPaths.push(file.absPath)
    }

    // Ruling 9: an unchanged upsert is a no-op and cannot clear missing, so explicitly
    // reset the flag for rows present in this scan before marking the absent ones.
    // Reset and mark are both scoped to this source, so other roots imported into
    // the batch are untouched.
    for (let i = 0; i < presentPaths.length; i += RESET_CHUNK) {
      const slice = presentPaths.slice(i, i + RESET_CHUNK)
      db.prepare(
        `UPDATE photos SET missing = 0
         WHERE batch_id = ? AND source_id = ? AND missing = 1
           AND abs_path IN (${slice.map(() => '?').join(', ')})`
      ).run(batchId, sourceId, ...slice)
    }

    const missing = markMissing(db, batchId, new Set(presentPaths), sourceId)
    return { added, updated, missing }
  })()
}
