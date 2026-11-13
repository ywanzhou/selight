// Bounded-concurrency async queue with in-flight dedupe. Zero Electron imports
// so the whole scheduling contract is unit-testable under bare Node.
export class MediaQueue {
  private readonly queued: number[] = []
  private readonly active = new Set<number>()
  private running = 0
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

  // splice (not unshift) so the given relative order survives at the front.
  prioritize(ids: number[]): void {
    const fresh = ids.filter((id) => !this.isKnown(id))
    if (fresh.length > 0) this.queued.splice(0, 0, ...fresh)
    this.pump()
  }

  onIdle(cb: () => void): void {
    this.idleCallbacks.add(cb)
  }

  private isKnown(id: number): boolean {
    return this.active.has(id) || this.queued.includes(id)
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queued.length > 0) {
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
