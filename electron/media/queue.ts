// Bounded-concurrency async queue with in-flight dedupe. Zero Electron imports
// so the whole scheduling contract is unit-testable under bare Node.
export class MediaQueue {
  private readonly queued: number[] = []
  private readonly active = new Set<number>()
  private running = 0
  private stopped = false
  private readonly idleCallbacks = new Set<() => void>()

  constructor(
    private readonly worker: (id: number) => Promise<void>,
    private readonly concurrency = 2
  ) {}

  /** Ids waiting for a worker slot, in processing order (front is next). */
  get pending(): readonly number[] {
    return this.queued
  }

  enqueue(ids: number[]): void {
    let added = false
    for (const id of ids) {
      if (this.isKnown(id)) continue
      this.queued.push(id)
      added = true
    }
    if (added) this.pump()
  }

  // Active ids are left running; ids already waiting are re-ranked to the
  // front so viewport signals can overtake bulk work, then fresh ids join the
  // front in input order.
  prioritize(ids: number[]): void {
    // Input may repeat (rapid viewport signals); active ids stay running and
    // duplicates collapse to one queue entry each.
    const movable = [...new Set(ids)].filter((id) => !this.active.has(id))
    if (movable.length === 0) return
    for (const id of movable) {
      const index = this.queued.indexOf(id)
      if (index >= 0) this.queued.splice(index, 1)
    }
    this.queued.unshift(...movable)
    this.pump()
  }

  onIdle(cb: () => void): void {
    this.idleCallbacks.add(cb)
  }

  // True when nothing is running or waiting. Lets callers distinguish "already
  // drained" from "will drain later", since onIdle only fires on a transition.
  get isIdle(): boolean {
    return this.running === 0 && this.queued.length === 0
  }

  // Shutdown gate: once stopped, enqueue/prioritize may still buffer ids but pump()
  // never starts another worker, so in-flight tasks finish naturally and nothing queued
  // after stop runs. Idle still fires when the last in-flight task lands.
  stop(): void {
    this.stopped = true
  }

  // Cancel waiting work without closing the queue: queued ids are dropped while
  // in-flight tasks run to completion, and later enqueue calls still pump. This
  // is the import-cancel path, distinct from the permanent stop() on app quit.
  cancel(): void {
    this.queued.length = 0
  }

  private isKnown(id: number): boolean {
    return this.active.has(id) || this.queued.includes(id)
  }

  private pump(): void {
    while (!this.stopped && this.running < this.concurrency && this.queued.length > 0) {
      const id = this.queued.shift()!
      this.active.add(id)
      this.running += 1
      // A rejection is contained to this id: the queue keeps draining.
      this.worker(id)
        .catch((err: unknown) => {
          console.error(`[selight] media queue worker failed for photo ${id}`, err)
        })
        .finally(() => {
          this.running -= 1
          this.active.delete(id)
          if (this.stopped) {
            // Queued ids must stay unstarted, but the last in-flight completion still idles.
            if (this.running === 0) this.notifyIdle()
            return
          }
          if (this.queued.length > 0) {
            this.pump()
          } else if (this.running === 0) {
            this.notifyIdle()
          }
        })
    }
  }

  private notifyIdle(): void {
    for (const cb of this.idleCallbacks) {
      try {
        cb()
      } catch (err) {
        console.error('[selight] media queue onIdle callback failed', err)
      }
    }
  }
}
