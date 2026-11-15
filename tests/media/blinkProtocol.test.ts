import { describe, expect, it, vi } from 'vitest'
import {
  BLINK_JPEG_QUALITY,
  BLINK_MAX_CONCURRENCY,
  BLINK_THUMB_WIDTH,
  BLINK_TIMEOUT_MS,
  BlinkThumbnailError,
  isAllowedAbsPath,
  isDecodeReply,
  isDecodeRequest,
  normalizeBlinkError,
  withTimeout
} from '../../electron/shared/blinkProtocol'

describe('blink protocol constants (Ruling 18)', () => {
  it('pins the agreed width, quality, timeout and concurrency', () => {
    expect(BLINK_THUMB_WIDTH).toBe(320)
    expect(BLINK_JPEG_QUALITY).toBeCloseTo(0.85)
    expect(BLINK_TIMEOUT_MS).toBe(10_000)
    expect(BLINK_MAX_CONCURRENCY).toBe(2)
  })
})

describe('isDecodeRequest', () => {
  it('accepts a well-formed request', () => {
    expect(
      isDecodeRequest({ requestId: 1, photoId: 7, absPath: 'E:/corpus/a.webp' })
    ).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', [1, 2]],
    ['missing requestId', { photoId: 7, absPath: 'a.webp' }],
    ['zero requestId', { requestId: 0, photoId: 7, absPath: 'a.webp' }],
    ['negative requestId', { requestId: -1, photoId: 7, absPath: 'a.webp' }],
    ['fractional requestId', { requestId: 1.5, photoId: 7, absPath: 'a.webp' }],
    ['string requestId', { requestId: '1', photoId: 7, absPath: 'a.webp' }],
    ['bad photoId', { requestId: 1, photoId: 0, absPath: 'a.webp' }],
    ['missing absPath', { requestId: 1, photoId: 7 }],
    ['empty absPath', { requestId: 1, photoId: 7, absPath: '' }],
    ['non-string absPath', { requestId: 1, photoId: 7, absPath: 42 }]
  ])('rejects %s', (_label, value) => {
    expect(isDecodeRequest(value)).toBe(false)
  })
})

describe('isDecodeReply', () => {
  it('accepts a success reply carrying a non-empty ArrayBuffer', () => {
    const reply = { requestId: 1, ok: true, jpeg: new ArrayBuffer(8) }
    expect(isDecodeReply(reply)).toBe(true)
  })

  it('accepts a failure reply carrying a non-empty error string', () => {
    expect(isDecodeReply({ requestId: 1, ok: false, error: 'boom' })).toBe(true)
  })

  it.each([
    ['null', null],
    ['bad requestId', { requestId: 0, ok: false, error: 'x' }],
    ['missing ok flag', { requestId: 1, error: 'x' }],
    ['success without jpeg', { requestId: 1, ok: true }],
    ['success with an empty buffer', { requestId: 1, ok: true, jpeg: new ArrayBuffer(0) }],
    ['success with a non-ArrayBuffer', { requestId: 1, ok: true, jpeg: new Uint8Array(8) }],
    ['failure without error text', { requestId: 1, ok: false }],
    ['failure with an empty error', { requestId: 1, ok: false, error: '' }]
  ])('rejects %s', (_label, value) => {
    expect(isDecodeReply(value)).toBe(false)
  })
})

describe('isAllowedAbsPath', () => {
  const allowed = new Set(['E:/corpus/a.webp', 'E:/corpus/b.webp'])

  it('admits only exact members of the whitelist set', () => {
    expect(isAllowedAbsPath('E:/corpus/a.webp', allowed)).toBe(true)
    expect(isAllowedAbsPath('E:/corpus/c.webp', allowed)).toBe(false)
  })

  it.each([
    ['empty string', ''],
    ['a number', 42],
    ['null', null],
    ['a traversal attempt', 'E:/corpus/../secret.webp']
  ])('rejects %s', (_label, value) => {
    expect(isAllowedAbsPath(value, allowed)).toBe(false)
  })
})

describe('normalizeBlinkError', () => {
  it('builds a coded BlinkThumbnailError with a fixed prefix and preserves the cause', () => {
    const cause = new Error('root')
    const err = normalizeBlinkError('BLINK_TIMEOUT', 'request 3 timed out', cause)
    expect(err).toBeInstanceOf(BlinkThumbnailError)
    expect(err.name).toBe('BlinkThumbnailError')
    expect(err.code).toBe('BLINK_TIMEOUT')
    expect(err.message).toBe('[selight] blink thumbnail: request 3 timed out')
    expect(err.cause).toBe(cause)
  })

  it('works without a cause', () => {
    const err = normalizeBlinkError('BLINK_NOT_WHITELISTED', 'denied')
    expect(err.code).toBe('BLINK_NOT_WHITELISTED')
    expect(err.cause).toBeUndefined()
  })
})

describe('withTimeout', () => {
  it('resolves with the task value when the task finishes first', async () => {
    await expect(withTimeout(async () => 'done', 100, 'label')).resolves.toBe('done')
  })

  it('rejects with a coded BLINK_TIMEOUT error when the task is too slow', async () => {
    vi.useFakeTimers()
    try {
      const slow = new Promise<string>(() => {
        // Never settles.
      })
      const result = withTimeout(() => slow, 100, 'slow decode')
      // Attach the rejection handler before the timer fires to avoid an unhandled rejection.
      const assertion = expect(result).rejects.toMatchObject({
        name: 'BlinkThumbnailError',
        code: 'BLINK_TIMEOUT'
      })
      await vi.advanceTimersByTimeAsync(101)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates the original task rejection without wrapping it', async () => {
    const boom = new Error('task boom')
    await expect(
      withTimeout(async () => {
        throw boom
      }, 100, 'label')
    ).rejects.toBe(boom)
  })
})
