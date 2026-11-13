import { describe, expect, it } from 'vitest'
import { DROP_MIME, parseDropPayload } from '../../src/state/drop'

// DOM-free contract: the function only touches a getData-shaped object, so the
// whole drag payload parsing runs under bare Node. The component call site is
// responsible for passing the real DataTransfer (or a fake in the smoke harness).

function dtWith(mime: string, data: string): { getData: (m: string) => string } {
  return {
    getData(m: string): string {
      return m === mime ? data : ''
    }
  }
}

describe('parseDropPayload', () => {
  it('parses a JSON array of photo ids written under the drop mime', () => {
    const dt = dtWith(DROP_MIME, JSON.stringify([1, 7, 42]))
    expect(parseDropPayload(dt)).toEqual([1, 7, 42])
  })

  it('returns [] for invalid JSON', () => {
    expect(parseDropPayload(dtWith(DROP_MIME, 'not-json{'))).toEqual([])
  })

  it('returns [] for a null or undefined argument', () => {
    expect(parseDropPayload(null)).toEqual([])
    expect(parseDropPayload(undefined)).toEqual([])
  })

  it('returns [] when the argument has no getData method', () => {
    expect(parseDropPayload({})).toEqual([])
    expect(
      parseDropPayload({ getData: 'nope' } as unknown as {
        getData: (mime: string) => string
      })
    ).toEqual([])
  })

  it('returns [] when getData returns an empty string (missing mime or empty drag)', () => {
    expect(parseDropPayload(dtWith(DROP_MIME, ''))).toEqual([])
  })

  it('returns [] when the payload lives under a different mime', () => {
    const dt = dtWith('text/plain', JSON.stringify([1, 2]))
    expect(parseDropPayload(dt)).toEqual([])
  })

  it('filters non-number elements while keeping the numbers', () => {
    const dt = dtWith(DROP_MIME, JSON.stringify([1, '2', null, true, { id: 2 }, 3]))
    expect(parseDropPayload(dt)).toEqual([1, 3])
  })

  it('dedupes repeated ids while preserving first-seen order', () => {
    const dt = dtWith(DROP_MIME, JSON.stringify([3, 1, 3, 2, 1, 2]))
    expect(parseDropPayload(dt)).toEqual([3, 1, 2])
  })

  it('returns [] for JSON that is not an array', () => {
    expect(parseDropPayload(dtWith(DROP_MIME, JSON.stringify({ ids: [1] })))).toEqual([])
    expect(parseDropPayload(dtWith(DROP_MIME, JSON.stringify(true)))).toEqual([])
    expect(parseDropPayload(dtWith(DROP_MIME, JSON.stringify('1,2')))).toEqual([])
    expect(parseDropPayload(dtWith(DROP_MIME, '12'))).toEqual([])
  })

  it('treats an empty array (empty-selection drag) as no ids', () => {
    expect(parseDropPayload(dtWith(DROP_MIME, '[]'))).toEqual([])
  })

  it('filters nested arrays and other non-number scalars', () => {
    const dt = dtWith(DROP_MIME, JSON.stringify([1, [2], null, '3', true, 4]))
    expect(parseDropPayload(dt)).toEqual([1, 4])
  })
})
