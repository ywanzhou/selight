import fs from 'node:fs'
import path from 'node:path'
import type { MediaKind } from '../shared/api'
import type { MediaQueue } from './queue'
import type { MediaRoots } from './resolve'

// Manual recovery for permanent placeholders: delete the cached artifact and
// its sidecar, then re-enqueue on the matching on-demand queue. The read-only
// source file is never addressed here. Force-flags make a missing artifact a
// safe no-op so retry also works before the first generation completed.
export function retryMediaGeneration(
  roots: MediaRoots,
  kind: MediaKind,
  id: number,
  queues: {
    thumb: Pick<MediaQueue, 'enqueue'>
    photo: Pick<MediaQueue, 'enqueue'>
  }
): void {
  const dir = kind === 'thumb' ? roots.thumbDir : roots.previewDir
  const file = path.join(dir, `${id}.jpg`)
  fs.rmSync(file, { force: true })
  fs.rmSync(`${file}.placeholder`, { force: true })
  queues[kind].enqueue([id])
}
