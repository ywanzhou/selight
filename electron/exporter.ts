import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { listFolders } from './domain/folders'
import { listPhotos, type PhotoRow } from './domain/photos'

// Electron-free export engine: node:fs/path only, so the whole copy contract runs
// under bare Node in tests/exporter.test.ts. Sources are opened read-only — every
// write lands under outputDir, never on a source path.

export interface ExportResult {
  copied: number
  /** abs_path of every photo that could not be copied; one bad file never aborts the run. */
  failures: string[]
}

export type ExportProgress = (done: number, total: number) => void

// Pick a non-existing destination inside dir for filename, adding " (1)", " (2)"
// before the final extension on each collision. path.extname keeps multi-dot names
// intact ('a.b.jpg' -> 'a.b (1).jpg') and returns '' for extension-less names.
export function uniqueDestination(dir: string, filename: string): string {
  const ext = path.extname(filename)
  const base = ext ? filename.slice(0, -ext.length) : filename
  let candidate = path.join(dir, filename)
  let suffix = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${suffix})${ext}`)
    suffix += 1
  }
  return candidate
}

interface WorkItem {
  folderName: string
  photo: PhotoRow
}

// Spec §7: one same-named subdirectory per non-empty live folder; only status='folder'
// photos are listed, so inbox and trash contents are excluded by construction
// (trash rows keep their folder_id but are never status='folder').
function gatherWork(db: Database, batchId: number): WorkItem[] {
  const items: WorkItem[] = []
  for (const folder of listFolders(db, batchId)) {
    const photos = listPhotos(db, batchId, { kind: 'folder', folderId: folder.id })
    if (photos.length === 0) continue
    for (const photo of photos) items.push({ folderName: folder.name, photo })
  }
  return items
}

export async function exportBatch(
  db: Database,
  batchId: number,
  outputDir: string,
  onProgress: ExportProgress = () => undefined
): Promise<ExportResult> {
  // The picker is responsible for choosing the directory; here we only verify it is
  // an existing directory. Its contents are never deleted or enumerated for cleanup.
  const stat = await fs.promises.stat(outputDir)
  if (!stat.isDirectory()) {
    throw new Error(`export output is not a directory: ${outputDir}`)
  }

  const items = gatherWork(db, batchId)
  const total = items.length
  const failures: string[] = []
  let copied = 0
  let done = 0

  for (const item of items) {
    try {
      const subdir = path.join(outputDir, item.folderName)
      await fs.promises.mkdir(subdir, { recursive: true })
      const destination = uniqueDestination(subdir, item.photo.filename)
      // copyFile reads the source and writes a new inode: source mtime/size cannot change.
      await fs.promises.copyFile(item.photo.absPath, destination)
      copied += 1
    } catch {
      failures.push(item.photo.absPath)
    } finally {
      done += 1
      onProgress(done, total)
    }
  }

  return { copied, failures }
}
