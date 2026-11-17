import fs from 'node:fs'
import type { Database } from 'better-sqlite3'
import { findEnrichedPhotoIds } from '../domain/photos'
import type { MediaQueue } from './queue'
import type { MediaRoots } from './resolve'

// Idle backfill, the automatic counterpart of viewport-driven generation:
// whenever the thumbnail queue drains, page through enriched rows and enqueue
// those whose thumbnail does not exist yet. Ordinary enqueue (not prioritize)
// means viewport signals still jump ahead of background work. Existing
// artifacts, including permanent placeholders, are never overwritten here —
// placeholder recovery is the user's explicit retryMedia action.
export function scheduleThumbnailBackfill(
  db: Database,
  queue: Pick<MediaQueue, 'enqueue' | 'onIdle'>,
  roots: MediaRoots,
  batchSize = 50
): void {
  const run = (): void => {
    let existing: Set<string>
    try {
      existing = new Set(fs.readdirSync(roots.thumbDir))
    } catch {
      existing = new Set()
    }

    // Page through ALL enriched candidates. A fixed LIMIT without OFFSET
    // would keep returning the first saturated window once its thumbnails
    // exist, stranding every later id.
    const missing: number[] = []
    let offset = 0
    for (;;) {
      const candidates = findEnrichedPhotoIds(db, batchSize, offset)
      if (candidates.length === 0) break
      for (const id of candidates) {
        // A placeholder sidecar means generation was already attempted and
        // failed: do not self-sustain a retry loop on an unwritable disk.
        if (existing.has(`${id}.jpg`) || existing.has(`${id}.jpg.placeholder`)) {
          continue
        }
        missing.push(id)
      }
      if (candidates.length < batchSize) break
      offset += batchSize
    }

    if (missing.length > 0) queue.enqueue(missing)
  }

  // Lives for the app/process lifetime, same as the queue it schedules onto.
  queue.onIdle(run)
}
