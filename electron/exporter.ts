import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { listFolders } from './domain/folders'
import { listPhotos, type PhotoRow } from './domain/photos'

// Electron-free export engine: node:fs/path only, so the whole copy contract runs
// under bare Node in tests/exporter.test.ts. Sources are opened read-only — every
// write lands under outputDir, never on a source path.

export interface ExportResult {
  /** abs_path of every photo that could not be copied; one bad file never aborts the run. */
  failures: string[]
  copied: number
}

export type ExportProgress = (done: number, total: number) => void

// Same shape as media/resolve.ts isInside: true for the root itself and anything
// beneath it; a '..' escape or absolute different-drive path makes rel start with
// '..' or stay absolute. Folder names are user input, so every subdirectory must
// pass this before mkdir/copy ever sees it.
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

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

interface WorkGroup {
  folderName: string
  photos: PhotoRow[]
  /** False when the folder name resolves outside outputDir; the whole group is skipped. */
  safe: boolean
}

// Spec §7: one same-named subdirectory per non-empty live folder; only status='folder'
// photos are listed, so inbox and trash contents are excluded by construction
// (trash rows keep their folder_id but are never status='folder').
function gatherWork(db: Database, batchId: number, outputRoot: string): WorkGroup[] {
  const groups: WorkGroup[] = []
  for (const folder of listFolders(db, batchId)) {
    const photos = listPhotos(db, batchId, { kind: 'folder', folderId: folder.id })
    if (photos.length === 0) continue
    const subdir = path.resolve(outputRoot, folder.name)
    groups.push({ folderName: folder.name, photos, safe: isInside(outputRoot, subdir) })
  }
  return groups
}

// Bound for COPYFILE_EXCL EEXIST retries: uniqueDestination already prevents
// collisions, so this only absorbs a same-tick racing writer. 100 suffixes is far
// past any realistic race and keeps the loop finite.
const MAX_EXCL_RETRIES = 100

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
  const outputRoot = path.resolve(outputDir)

  const groups = gatherWork(db, batchId, outputRoot)
  const total = groups.reduce((n, group) => n + group.photos.length, 0)
  const failures: string[] = []
  let copied = 0
  let done = 0

  for (const group of groups) {
    // Containment failure is a whole-group skip: no mkdir, no copy. Each photo is
    // recorded with the reason so the dialog can explain what was not exported.
    if (!group.safe) {
      for (const photo of group.photos) {
        failures.push(`${photo.absPath}（文件夹名越界，已跳过：${group.folderName}）`)
        done += 1
        onProgress(done, total)
      }
      continue
    }

    const subdir = path.join(outputRoot, group.folderName)
    await fs.promises.mkdir(subdir, { recursive: true })

    for (const photo of group.photos) {
      try {
        let destination = uniqueDestination(subdir, photo.filename)
        // COPYFILE_EXCL makes overwriting impossible at the syscall layer even if a
        // racing writer creates the file after uniqueDestination's existsSync check.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await fs.promises.copyFile(
              photo.absPath,
              destination,
              fs.constants.COPYFILE_EXCL
            )
            break
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= MAX_EXCL_RETRIES) {
              throw err
            }
            destination = uniqueDestination(subdir, photo.filename)
          }
        }
        // copyFile reads the source and writes a new inode: source mtime/size cannot change.
        copied += 1
      } catch {
        failures.push(photo.absPath)
      } finally {
        done += 1
        onProgress(done, total)
      }
    }
  }

  return { copied, failures }
}
