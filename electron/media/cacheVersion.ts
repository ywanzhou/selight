import fs from 'node:fs'
import path from 'node:path'
import type { MediaRoots } from './resolve'

// Bump whenever media generation changes in a way that makes already-cached
// artifacts obsolete. v2: RAW extraction prefers the full-size PreviewImage over
// the 160px ThumbnailImage, so every pre-v2 RAW cache must be rebuilt.
export const MEDIA_CACHE_VERSION = 2
export const CACHE_VERSION_FILE = 'media-cache-version'

export interface CacheVersionPlan {
  versionFile: string
  stale: boolean
  /** Cache directories to wipe when stale; empty when the cache is current. */
  dirs: string[]
}

// Pure decision step: reads the persisted version and plans the reset without
// touching the cache directories, so the policy is testable without side effects.
export function planCacheVersionReset(
  roots: MediaRoots,
  userData: string,
  version: number = MEDIA_CACHE_VERSION
): CacheVersionPlan {
  const versionFile = path.join(userData, CACHE_VERSION_FILE)
  let stored: string | null = null
  try {
    stored = fs.readFileSync(versionFile, 'utf8').trim()
  } catch {
    stored = null
  }
  const stale = stored !== String(version)
  return {
    versionFile,
    stale,
    dirs: stale ? [roots.thumbDir, roots.previewDir] : []
  }
}

// Wipes the managed cache directories on a version mismatch, recreates them empty
// and stamps the new version. The version file lives in userData, outside the
// wiped directories. Thumbnails are repopulated by the idle backfill; previews are
// regenerated on demand when the renderer asks for them.
export function resetMediaCacheIfStale(
  roots: MediaRoots,
  userData: string,
  version: number = MEDIA_CACHE_VERSION
): { reset: boolean } {
  const plan = planCacheVersionReset(roots, userData, version)
  if (!plan.stale) return { reset: false }

  for (const dir of plan.dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(plan.versionFile, String(version))
  return { reset: true }
}
