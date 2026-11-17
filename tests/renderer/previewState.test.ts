import { describe, expect, it } from 'vitest'
import { derivePreviewState, type PreviewStateInput } from '../../src/state/previewState'

const base: PreviewStateInput = { missing: false, loadFailed: false, loaded: false }

describe('derivePreviewState', () => {
  it('is loading before the image settles', () => {
    expect(derivePreviewState(base)).toBe('loading')
  })

  it('is ready once loaded', () => {
    expect(derivePreviewState({ ...base, loaded: true })).toBe('ready')
  })

  it('is failed on a load error while the row exists', () => {
    expect(derivePreviewState({ ...base, loadFailed: true })).toBe('failed')
  })

  it('treats a missing row as missing even when a load error fired', () => {
    // missing must win so deleted/moved files show the message, never an
    // infinite loading spinner or a retry that cannot succeed.
    expect(
      derivePreviewState({ missing: true, loadFailed: true, loaded: false })
    ).toBe('missing')
  })

  it('prefers ready over a stale transient failure flag', () => {
    expect(
      derivePreviewState({ missing: false, loadFailed: true, loaded: true })
    ).toBe('ready')
  })

  it('maps every state to one of the four known labels', () => {
    const labels: ReturnType<typeof derivePreviewState>[] = [
      'loading',
      'ready',
      'failed',
      'missing'
    ]
    for (const missing of [false, true]) {
      for (const loadFailed of [false, true]) {
        for (const loaded of [false, true]) {
          expect(labels).toContain(
            derivePreviewState({ missing, loadFailed, loaded })
          )
        }
      }
    }
  })
})
