import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaQueue } from '../../electron/media/queue'

// Gate that a fake worker waits on, so tests can step the queue deterministically.
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((res) => {
    release = res
  })
  return { promise, release }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MediaQueue enqueue and FIFO order', () => {
  it('processes ids in insertion order at concurrency 1', async () => {
    const gates = new Map<number, ReturnType<typeof gate>>()
    const started: number[] = []
    const queue = new MediaQueue(async (id) => {
      started.push(id)
      let g = gates.get(id)
      if (!g) {
        g = gate()
        gates.set(id, g)
      }
      await g.promise
    }, 1)

    queue.enqueue([1, 2, 3])
    await flushMicrotasks()
    expect(started).toEqual([1])
    expect([...queue.pending]).toEqual([2, 3])

    gates.get(1)!.release()
    await flushMicrotasks()
    expect(started).toEqual([1, 2])
    gates.get(2)!.release()
    await flushMicrotasks()
    gates.get(3)!.release()
    await flushMicrotasks()

    expect(started).toEqual([1, 2, 3])
    expect(queue.pending).toHaveLength(0)
  })

  it('never enqueues an id that is already queued or running', async () => {
    const g = gate()
    const calls: number[] = []
    const queue = new MediaQueue(async (id) => {
      calls.push(id)
      await g.promise
    }, 1)

    queue.enqueue([1, 1, 2, 1, 2])
    await flushMicrotasks()
    expect([...queue.pending]).toEqual([2])
    expect(calls).toEqual([1])

    g.release()
    await flushMicrotasks()
    expect(calls).toEqual([1, 2])
  })
})

describe('MediaQueue concurrency cap', () => {
  it('runs at most two workers by default even with many queued ids', async () => {
    const gates = new Map<number, ReturnType<typeof gate>>()
    let active = 0
    let maxActive = 0
    const queue = new MediaQueue(async (id) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      let g = gates.get(id)
      if (!g) {
        g = gate()
        gates.set(id, g)
      }
      await g.promise
      active -= 1
    })

    queue.enqueue([1, 2, 3, 4, 5, 6])
    await flushMicrotasks()
    expect(maxActive).toBe(2)
    expect([...queue.pending]).toEqual([3, 4, 5, 6])

    for (const id of [1, 2, 3, 4, 5, 6]) {
      gates.get(id)!.release()
      await flushMicrotasks()
    }
    expect(maxActive).toBe(2)
    expect(queue.pending).toHaveLength(0)
  })
})

describe('MediaQueue.prioritize', () => {
  it('inserts fresh ids at the front and re-ranks ids already waiting, leaving active ids alone', async () => {
    const g1 = gate()
    const queue = new MediaQueue(async (id) => {
      if (id === 1) await g1.promise
    }, 1)

    queue.enqueue([1, 2, 3])
    await flushMicrotasks()
    expect([...queue.pending]).toEqual([2, 3])

    queue.prioritize([4])
    expect([...queue.pending]).toEqual([4, 2, 3])

    // 1 is active and stays untouched; 2 was already waiting and jumps to the
    // front ahead of 4; 5 is fresh and slots in behind the re-ranked 2.
    queue.prioritize([1, 2, 5])
    expect([...queue.pending]).toEqual([2, 5, 4, 3])

    g1.release()
    await new Promise<void>((resolve) => queue.onIdle(() => resolve()))
    expect(queue.pending).toHaveLength(0)
  })

  it('moves a whole already-queued batch back to the front in input order', async () => {
    const gates = new Map<number, ReturnType<typeof gate>>()
    const queue = new MediaQueue(async (id) => {
      let g = gates.get(id)
      if (!g) {
        g = gate()
        gates.set(id, g)
      }
      await g.promise
    })
    queue.enqueue([1, 2, 3, 4])
    await flushMicrotasks()
    // Concurrency 2 pins 1 and 2 active; 3 and 4 wait in FIFO order.
    expect([...queue.pending]).toEqual([3, 4])

    queue.prioritize([4, 3])
    expect([...queue.pending]).toEqual([4, 3])

    // Release the two active workers; both freed slots then pick up the
    // re-ranked pair, so 4 and 3 are active together with gates materialized.
    gates.get(1)!.release()
    gates.get(2)!.release()
    await flushMicrotasks()
    expect(queue.pending).toHaveLength(0)
    expect(gates.has(4)).toBe(true)
    expect(gates.has(3)).toBe(true)
    gates.get(4)!.release()
    gates.get(3)!.release()
    await new Promise<void>((resolve) => queue.onIdle(() => resolve()))
    expect(queue.pending).toHaveLength(0)
  })

  it('drains prioritized ids before ordinary queued ids', async () => {
    const order: number[] = []
    const gates = new Map<number, ReturnType<typeof gate>>()
    const queue = new MediaQueue(async (id) => {
      order.push(id)
      let g = gates.get(id)
      if (!g) {
        g = gate()
        gates.set(id, g)
      }
      await g.promise
    }, 1)

    queue.enqueue([1, 2, 3])
    await flushMicrotasks()
    queue.prioritize([9])
    gates.get(1)!.release()
    await flushMicrotasks()
    expect(order).toEqual([1, 9])
    for (const id of [9, 2, 3]) {
      gates.get(id)!.release()
      await flushMicrotasks()
    }
    expect(order).toEqual([1, 9, 2, 3])
  })
})

describe('MediaQueue.onIdle', () => {
  it('fires every registered callback when the queue drains, again on later drains', async () => {
    const events: string[] = []
    const queue = new MediaQueue(async () => {
      await Promise.resolve()
    })
    queue.onIdle(() => events.push('a'))
    queue.onIdle(() => events.push('b'))

    queue.enqueue([1])
    await new Promise<void>((resolve) => queue.onIdle(() => resolve()))
    expect(events).toEqual(['a', 'b'])

    queue.enqueue([2, 3])
    await new Promise<void>((resolve) => queue.onIdle(() => resolve()))
    expect(events).toEqual(['a', 'b', 'a', 'b'])
  })

  it('keeps draining after a worker rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const processed: number[] = []
    const queue = new MediaQueue(async (id) => {
      if (id === 2) throw new Error('boom')
      processed.push(id)
    })

    queue.enqueue([1, 2, 3])
    await new Promise<void>((resolve) => queue.onIdle(() => resolve()))

    expect(processed).toEqual([1, 3])
    expect(queue.pending).toHaveLength(0)
  })
})

describe('MediaQueue.stop', () => {
  it('never runs ids enqueued or prioritized after stop, leaving them pending', async () => {
    const calls: number[] = []
    const queue = new MediaQueue(async (id) => {
      calls.push(id)
    })

    queue.stop()
    queue.enqueue([1, 2])
    queue.prioritize([3])
    await flushMicrotasks()

    expect(calls).toEqual([])
    expect([...queue.pending].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('lets in-flight tasks finish, skips queued work, and still fires onIdle', async () => {
    const g = gate()
    const calls: number[] = []
    const queue = new MediaQueue(async (id) => {
      calls.push(id)
      if (id === 1) await g.promise
    }, 1)

    queue.enqueue([1, 2])
    await flushMicrotasks()
    expect(calls).toEqual([1])

    queue.stop()
    const idle = new Promise<void>((resolve) => queue.onIdle(() => resolve()))
    g.release()
    await idle

    // In-flight 1 ran to completion; queued 2 was never started after stop.
    expect(calls).toEqual([1])
    expect([...queue.pending]).toEqual([2])
  })
})
