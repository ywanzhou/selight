import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import type { MediaRoots } from './resolve'

const MAIN_RE = /^(\d+)\.jpg$/
const SIDECAR_RE = /^(\d+)\.jpg\.placeholder$/
// Leftover from an atomicWrite whose rename never completed (crash mid-write).
const TMP_RE = /^(\d+)\.jpg\.tmp$/

// Pure planning step (read-only): returns absolute paths safe to delete.
// A managed artifact is garbage when its photo row is gone or flagged
// missing, or when a sidecar has no matching main artifact. Only numeric
// managed filenames inside the cache roots are ever considered, so neither
// read-only sources nor unrelated files can be addressed.
export function planCacheCleanup(db: Database, roots: MediaRoots): string[] {
  const liveRows = db
    .prepare('SELECT id FROM photos WHERE missing = 0')
    .all() as { id: number }[]
  const liveIds = new Set(liveRows.map((row) => row.id))
  const removable: string[] = []

  for (const dir of [roots.thumbDir, roots.previewDir]) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }

    for (const name of entries) {
      const sidecar = SIDECAR_RE.exec(name)
      const main = MAIN_RE.exec(name)
      const tmp = TMP_RE.exec(name)
      if (!sidecar && !main && !tmp) continue

      const id = Number((sidecar ?? main ?? tmp)![1])
      const file = path.join(dir, name)

      // Crash leftovers and any artifact whose row is gone are always garbage.
      if (tmp || !liveIds.has(id)) {
        removable.push(file)
        continue
      }
      if (sidecar && !fs.existsSync(path.join(dir, `${id}.jpg`))) {
        // Orphan marker: the generation it describes never produced a main artifact.
        removable.push(file)
      }
    }
  }

  return removable
}

// Executes the plan and reports how many files were removed.
export async function runCacheCleanup(
  db: Database,
  roots: MediaRoots
): Promise<{ removed: number }> {
  const plan = planCacheCleanup(db, roots)
  for (const file of plan) {
    await fs.promises.rm(file, { force: true })
  }
  return { removed: plan.length }
}
