import { describe, expect, it } from 'vitest'
import type { MediaReadyEvent } from '../../electron/shared/api'
import { shouldReloadMedia } from '../../src/state/mediaReady'

const event = (overrides: Partial<MediaReadyEvent> = {}): MediaReadyEvent => ({
  id: 7,
  kind: 'thumb',
  ok: true,
  ...overrides
})

describe('shouldReloadMedia', () => {
  it('returns true when id and kind match a successful ready event', () => {
    expect(shouldReloadMedia(event(), 7, 'thumb')).toBe(true)
  })

  it('returns false for another photo id', () => {
    expect(shouldReloadMedia(event(), 8, 'thumb')).toBe(false)
  })

  it('returns false when the kind differs', () => {
    expect(shouldReloadMedia(event({ kind: 'thumb' }), 7, 'photo')).toBe(false)
    expect(shouldReloadMedia(event({ kind: 'photo' }), 7, 'thumb')).toBe(false)
  })

  it('returns false on ok:false — the placeholder sidecar is already the final state', () => {
    expect(shouldReloadMedia(event({ ok: false }), 7, 'thumb')).toBe(false)
  })
})
