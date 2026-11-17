import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { upsertPhoto } from '../../electron/domain/photos'
import { MediaQueue } from '../../electron/media/queue'
import { scheduleThumbnailBackfill } from '../../electron/media/backfill'

const dirs: string[] = []
const handles: Database[] = []

function setup(): {
  db: Database
  thumbDir: string
  addPhoto: (absPath: string) => number
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-backfill-'))
  dirs.push(root)
  const { db } = openDatabase(path.join(root, 'selight.db'))
  handles.push(db)
  const thumbDir = path.join(root, 'thumbnails')
  const previewDir = path.join(root, 'previews')
  fs.mkdirSync(thumbDir, { recursive: true })
  fs.mkdirSync(previewDir, { recursive: true })
  const batchId = createBatch(db).id

  const addPhoto = (absPath: string): number => {
    db.prepare(
      `INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)
         ON CONFLICT(batch_id, abs_path) DO NOTHING`
    ).run(batchId, path.dirname(absPath))
    const sourceId = Number(
      (
        db
          .prepare('SELECT id FROM sources WHERE batch_id = ? AND abs_path = ?')
          .get(batchId, path.dirname(absPath)) as { id: number }
      ).id
    )
    return upsertPhoto(db, {
      batchId,
      sourceId,
      absPath,
      filename: path.basename(absPath),
      ext: path.extname(absPath),
      sizeBytes: 1,
      mtime: 1
    }).row.id
  }
  return { db, thumbDir, addPhoto }
}

afterEach(() => {
  while (handles.length) {
    const db = handles.pop()!
    if (db.open) db.close()
  }
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('scheduleThumbnailBackfill', () => {
  it('enqueues only enriched rows lacking a cached thumbnail when the queue drains', async () => {
    const { db, thumbDir, addPhoto } = setup()
    const withThumb = addPhoto(path.join(thumbDir, '..', 'a.jpg'))
    const missing = addPhoto(path.join(thumbDir, '..', 'b.jpg'))
    const unenriched = addPhoto(path.join(thumbDir, '..', 'c.jpg'))
    db.prepare('UPDATE photos SET width = 100, height = 80 WHERE id IN (?, ?)').run(
      withThumb,
      missing
    )
    // c stays width NULL and must never be a backfill candidate.
    fs.writeFileSync(path.join(thumbDir, `${withThumb}.jpg`), 'cached')

    const enqueued: number[][] = []
    const queue = new MediaQueue(async () => {
      await Promise.resolve()
    })
    const enqueue = queue.enqueue.bind(queue)
    queue.enqueue = (ids: number[]) => {
      enqueued.push([...ids])
      enqueue(ids)
    }
    scheduleThumbnailBackfill(
      db,
      queue,
      { thumbDir, previewDir: path.join(thumbDir, '..', 'previews') },
      50
    )

    // A real (immediately-settling) task produces the drain transition that
    // triggers the first backfill pass; an empty enqueue would not.
    const drained = new Promise<void>((resolve) => queue.onIdle(resolve))
    queue.enqueue([999_999])
    await drained

    const flat = [...new Set(enqueued.flat())]
    expect(flat).toContain(missing)
    expect(flat).not.toContain(withThumb)
    expect(flat).not.toContain(unenriched)
    queue.stop()
  })

  it('paginates past the first batch so every enriched row is eventually backfilled', async () => {
    const { db, thumbDir, addPhoto } = setup()
    const batchId = createBatch(db).id
    const count = 65
    for (let i = 0; i < count; i += 1) {
      addPhoto(path.join(thumbDir, '..', `p${i}.jpg`))
    }
    db.prepare('UPDATE photos SET width = 100, height = 80 WHERE width IS NULL').run()

    const enqueued: number[][] = []
    const queue = new MediaQueue(async () => {
      // Simulate the worker writing its artifact so fs filtering moves on.
      await Promise.resolve()
    })
    const originalEnqueue = queue.enqueue.bind(queue)
    queue.enqueue = (ids: number[]) => {
      enqueued.push([...ids])
      for (const id of ids) {
        fs.writeFileSync(path.join(thumbDir, `${id}.jpg`), 'x')
      }
      originalEnqueue(ids)
    }
    scheduleThumbnailBackfill(db, queue, { thumbDir, previewDir: '' }, 50)

    // Two drain transitions: the first fills ids 1..50, the second must page
    // past them to reach the remaining 15 instead of re-querying the same window.
    queue.enqueue([999_999])
    await new Promise<void>((resolve) => queue.onIdle(resolve))
    queue.enqueue([999_998])
    await new Promise<void>((resolve) => queue.onIdle(resolve))

    // Exclude the dummy ids used to trigger drain transitions.
    const backfilled = new Set(
      enqueued.flat().filter((id) => id < 900_000)
    )
    expect(backfilled.size).toBe(count)
    expect(Math.max(...backfilled)).toBe(count)
    queue.stop()
    void batchId
  })

  it('uses ordinary enqueue (not prioritize) so viewport signals keep overtaking', async () => {
    const { db, thumbDir, addPhoto } = setup()
    addPhoto('E:/1.jpg')
    addPhoto('E:/2.jpg')
    db.prepare('UPDATE photos SET width = 100, height = 80 WHERE width IS NULL').run()

    const queue = new MediaQueue(async () => {
      await Promise.resolve()
    })
    const enqueueCalls: number[][] = []
    const prioritizeSpy = vi.spyOn(queue, 'prioritize')
    const originalEnqueue = queue.enqueue.bind(queue)
    queue.enqueue = (ids: number[]) => {
      enqueueCalls.push([...ids])
      originalEnqueue(ids)
    }
    scheduleThumbnailBackfill(
      db,
      queue,
      { thumbDir, previewDir: path.join(thumbDir, '..', 'previews') },
      50
    )

    // A settling task produces the drain that runs the backfill pass.
    const drained = new Promise<void>((resolve) => queue.onIdle(resolve))
    queue.enqueue([999_999])
    await drained

    // Backfill goes through the FIFO enqueue path; it never calls prioritize,
    // whose re-ranking contract is covered by tests/media/queue.test.ts.
    expect(enqueueCalls.flat().sort((a, b) => a - b)).toContain(1)
    expect(prioritizeSpy).not.toHaveBeenCalled()
    queue.stop()
  })
})
