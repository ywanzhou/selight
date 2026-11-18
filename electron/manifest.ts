import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { getBatch } from './domain/batches'
import { listFolders } from './domain/folders'
import { listPhotos } from './domain/photos'

// Electron-free manifest engine: node:fs/path plus an injected db handle, so the
// whole contract runs under bare Node in tests/manifest.test.ts. Sources are
// opened read-only — the only write this module performs is the target JSON file
// the user picked, via a sibling .tmp then rename.

export interface ManifestPhoto {
  sourceId: number
  /** Posix path relative to the photo's source root; stable across machines. */
  path: string
  /** Original absolute path on the exporting machine, kept for reference. */
  absPath: string
  filename: string
  sizeBytes: number
  missing: boolean
}

export interface ManifestFolder {
  id: number
  name: string
  photos: ManifestPhoto[]
}

export interface ManifestSource {
  id: number
  root: string
}

export interface Manifest {
  kind: 'selight-manifest'
  version: 1
  batch: {
    id: number
    name: string
    exportedAt: string
  }
  sources: ManifestSource[]
  folders: ManifestFolder[]
}

export interface ManifestResult {
  targetPath: string
  folderCount: number
  photoCount: number
  missingCount: number
}

interface SourceSnake {
  id: number
  abs_path: string
}

/** Normalize a path to forward slashes so Windows-produced manifests work in Python on any OS. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** Make a string safe to use as a save-dialog file name (basename only, callers keep the dir). */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned === '' ? 'manifest' : cleaned
}

export function buildManifest(
  db: Database,
  batchId: number,
  now: number = Date.now()
): Manifest {
  const batch = getBatch(db, batchId)
  if (batch === undefined) {
    throw new Error(`batch not found: ${batchId}`)
  }

  const sourceRows = db
    .prepare('SELECT id, abs_path FROM sources WHERE batch_id = ? ORDER BY id')
    .all(batchId) as SourceSnake[]
  const sources: ManifestSource[] = sourceRows.map((row) => ({
    id: row.id,
    root: toPosix(row.abs_path)
  }))
  const rootById = new Map(sourceRows.map((row) => [row.id, row.abs_path]))

  const folders: ManifestFolder[] = []
  for (const folder of listFolders(db, batchId)) {
    // listPhotos with the folder view already restricts to status='folder', so
    // inbox and trash rows are excluded by construction; empty folders are skipped.
    const photos = listPhotos(db, batchId, { kind: 'folder', folderId: folder.id })
    if (photos.length === 0) continue

    folders.push({
      id: folder.id,
      name: folder.name,
      photos: photos.map((photo) => {
        const root = rootById.get(photo.sourceId)
        if (root === undefined) {
          // A photo without its source row is broken referential data, not a skip case:
          // a manifest with an unresolvable path would send the retoucher's script nowhere.
          throw new Error(`photo ${photo.id} references missing source ${photo.sourceId}`)
        }
        return {
          sourceId: photo.sourceId,
          path: toPosix(path.relative(root, photo.absPath)),
          absPath: toPosix(photo.absPath),
          filename: photo.filename,
          sizeBytes: photo.sizeBytes,
          missing: photo.missing === 1
        }
      })
    })
  }

  return {
    kind: 'selight-manifest',
    version: 1,
    batch: {
      id: batch.id,
      name: batch.name,
      exportedAt: new Date(now).toISOString()
    },
    sources,
    folders
  }
}

/** Atomic-ish write: a kill mid-write leaves a .tmp instead of a truncated manifest. */
export async function writeManifest(targetPath: string, manifest: Manifest): Promise<void> {
  const tmp = `${targetPath}.tmp`
  await fs.promises.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fs.promises.rename(tmp, targetPath)
}

export async function exportManifest(
  db: Database,
  batchId: number,
  targetPath: string,
  now?: number
): Promise<ManifestResult> {
  const manifest = buildManifest(db, batchId, now)
  await writeManifest(targetPath, manifest)

  let photoCount = 0
  let missingCount = 0
  for (const folder of manifest.folders) {
    photoCount += folder.photos.length
    for (const photo of folder.photos) {
      if (photo.missing) missingCount += 1
    }
  }

  return {
    targetPath,
    folderCount: manifest.folders.length,
    photoCount,
    missingCount
  }
}
