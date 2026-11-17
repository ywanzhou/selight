import fs from 'node:fs'
import type { Database } from 'better-sqlite3'
import { findEnrichedPhotoIds } from '../domain/photos'
import type { MediaQueue } from './queue'
import type { MediaRoots } from './resolve'

// Idle backfill, the automatic counterpart of viewport-driven generation:
// whenever the thumbnail queue drains, fill one batch of enriched rows whose
// thumbnail does not exist yet. Ordinary enqueue (not prioritize) means
// viewport signals still jump ahead of background work. Existing artifacts,
// including permanent placeholders, are never overwritten here — placeholder
// recovery is the user's explicit retryMedia action.
export function scheduleThumbnailBackfill(
  db: Database,
  queue: Pick<MediaQueue, 'enqueue' | 'onIdle'>,
  roots: MediaRoots,
  batchSize = 50
): void {
  const run = (): void => {
    const candidates = findEnrichedPhotoIds(db, batchSize)
    if (candidates.length === 0) return

    let existing: Set<string>
    try {
      existing = new Set(fs.readdirSync(roots.thumbDir))
    } catch {
      existing = new Set()
    }

    const missing = candidates.filter((id) => !existing.has(`${id}.jpg`))
    if (missing.length > 0) queue.enqueue(missing)
  }

  // Lives for the app/process lifetime, same as the queue it schedules onto.
  queue.onIdle(run)
}
