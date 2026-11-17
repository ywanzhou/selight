import type { Database } from 'better-sqlite3'
import sharp from 'sharp'
import { RAW_EXTENSIONS } from './formats'
import { orientDimensions } from './orientation'
import { MediaQueue } from './queue'
import type { ExifReader } from './rawPreview'

// Match the thumbnail pipeline: no cached file handles (Windows would otherwise
// lock the fixture/source files) and one libvips thread per operation.
sharp.concurrency(1)
sharp.cache({ files: 0 })

// Invariant (see spec §9): `width IS NULL` is the single "not enriched" marker.
// A successful pass always writes dimensions; every failure leaves the row
// untouched so the open-batch catch-up and thumbnail self-heal can retry it.

interface EnrichmentRow {
  id: number
  absPath: string
  ext: string
  width: number | null
}

const DIRECT_CONCURRENCY = 4
const RAW_CONCURRENCY = 2

function loadRow(db: Database, id: number): EnrichmentRow | undefined {
  return db
    .prepare(
      'SELECT id, abs_path AS absPath, ext, width FROM photos WHERE id = ?'
    )
    .get(id) as EnrichmentRow | undefined
}

// Enriches one photo: direct formats read EXIF/dimensions from the file header
// via sharp (no pixel decode), RAW goes through the injected exiftool reader.
// Returns true when this call performed the write, false when already
// enriched or when the attempt failed (row stays retryable).
export async function enrichPhoto(
  db: Database,
  id: number,
  reader: Pick<ExifReader, 'readImageMeta'>
): Promise<boolean> {
  const row = loadRow(db, id)
  if (row === undefined || row.width !== null) return false

  try {
    let orientation: number
    let storedWidth: number
    let storedHeight: number

    if (RAW_EXTENSIONS.has(row.ext.toLowerCase())) {
      const meta = await reader.readImageMeta(row.absPath, row.ext)
      if (meta.width === null || meta.height === null) {
        throw new Error(`RAW metadata missing dimensions for photo ${id}`)
      }
      orientation = meta.orientation
      storedWidth = meta.width
      storedHeight = meta.height
    } else {
      const meta = await sharp(row.absPath, { failOn: 'none' }).metadata()
      orientation = typeof meta.orientation === 'number' ? meta.orientation : 1
      if (meta.width === undefined || meta.height === undefined) {
        throw new Error(`sharp reported no dimensions for photo ${id}`)
      }
      storedWidth = meta.width
      storedHeight = meta.height
    }

    const { width, height } = orientDimensions(
      orientation,
      storedWidth,
      storedHeight
    )
    db.prepare(
      `UPDATE photos
         SET orientation = ?, width = ?, height = ?, updated_at = ?
       WHERE id = ?`
    ).run(orientation, width, height, Date.now(), id)
    return true
  } catch (err) {
    // Keep the NULL marker: the row must remain selectable for retry.
    console.error(`[selight] enrichment failed for photo ${id}`, err)
    return false
  }
}

export interface EnrichmentOptions {
  directConcurrency?: number
  rawConcurrency?: number
  onProgress?: (done: number, total: number) => void
}

// Process-wide singleton seam: one service instance per app (built in main.ts),
// fed by imports and open-batch catch-up alike. Two bounded pools keep direct
// (sharp header reads) and RAW (exiftool round trips) work separately so RAW
// latency cannot consume the direct pool. Internal dedupe means overlapping
// submits never process the same id twice.
export class EnrichmentService {
  private readonly direct: MediaQueue
  private readonly raw: MediaQueue
  private readonly inFlight = new Set<number>()
  private accepted = 0
  private finished = 0
  private readonly onProgress?: EnrichmentOptions['onProgress']

  constructor(
    private readonly db: Database,
    reader: Pick<ExifReader, 'readImageMeta'>,
    opts: EnrichmentOptions = {}
  ) {
    this.onProgress = opts.onProgress
    const settle = (id: number): void => {
      this.inFlight.delete(id)
      this.finished += 1
      this.onProgress?.(this.finished, this.accepted)
    }
    this.direct = new MediaQueue(
      async (id) => {
        try {
          await enrichPhoto(db, id, reader)
        } finally {
          settle(id)
        }
      },
      opts.directConcurrency ?? DIRECT_CONCURRENCY
    )
    this.raw = new MediaQueue(
      async (id) => {
        try {
          await enrichPhoto(db, id, reader)
        } finally {
          settle(id)
        }
      },
      opts.rawConcurrency ?? RAW_CONCURRENCY
    )
  }

  submit(ids: readonly number[]): void {
    for (const id of ids) {
      if (this.inFlight.has(id)) continue
      const row = loadRow(this.db, id)
      if (row === undefined || row.width !== null) continue
      this.inFlight.add(id)
      this.accepted += 1
      if (RAW_EXTENSIONS.has(row.ext.toLowerCase())) {
        this.raw.enqueue([id])
      } else {
        this.direct.enqueue([id])
      }
    }
  }

  // Test/backfill seam: resolves once both pools have drained. A queue that
  // never received work has no drain transition, so an already-idle queue
  // resolves its share immediately.
  whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      let pending = 2
      const tick = (): void => {
        pending -= 1
        if (pending === 0) resolve()
      }
      this.direct.onIdle(tick)
      this.raw.onIdle(tick)
      if (this.direct.isIdle) tick()
      if (this.raw.isIdle) tick()
    })
  }

  stop(): void {
    this.direct.stop()
    this.raw.stop()
  }

  // Cancel waiting work while keeping the service reusable: drop queued ids
  // (in-flight tasks finish naturally), reset progress bookkeeping and clear
  // the toolbar indicator. Distinct from stop(), which permanently closes both
  // queues on app quit.
  cancel(): void {
    this.direct.cancel()
    this.raw.cancel()
    this.inFlight.clear()
    this.accepted = 0
    this.finished = 0
    this.onProgress?.(0, 0)
  }
}
