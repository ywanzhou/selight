import { describe, expect, it } from 'vitest'
import { formatBatchDate, moveActiveIndex } from '../../src/state/batchPicker'

// DOM-free table tests for the custom batch picker: cyclic keyboard navigation
// and the three-tier relative date used in each option's subtitle.

describe('moveActiveIndex', () => {
  it('moves forward and wraps back to the first row', () => {
    expect(moveActiveIndex(0, 3, 1)).toBe(1)
    expect(moveActiveIndex(2, 3, 1)).toBe(0)
  })

  it('moves backward and wraps to the last row', () => {
    expect(moveActiveIndex(0, 3, -1)).toBe(2)
    expect(moveActiveIndex(2, 3, -1)).toBe(1)
  })

  it('stays put when the list has a single batch', () => {
    expect(moveActiveIndex(0, 1, 1)).toBe(0)
    expect(moveActiveIndex(0, 1, -1)).toBe(0)
  })

  it('returns 0 for an empty list instead of producing a negative index', () => {
    expect(moveActiveIndex(0, 0, 1)).toBe(0)
    expect(moveActiveIndex(0, 0, -1)).toBe(0)
  })

  it('clamps an out-of-range current index into the list bounds', () => {
    expect(moveActiveIndex(-1, 3, 1)).toBe(0)
    expect(moveActiveIndex(5, 3, -1)).toBe(2)
  })
})

describe('formatBatchDate', () => {
  // 2026-11-18 15:00 local time; injected as `now` so the test never depends
  // on the machine clock.
  const now = new Date(2026, 10, 18, 15, 0).getTime()

  it('labels a batch created earlier the same day as today', () => {
    const createdAt = new Date(2026, 10, 18, 9, 0).getTime()
    expect(formatBatchDate(createdAt, now)).toBe('今天创建')
  })

  it('formats an earlier date in the same year without a year prefix', () => {
    const createdAt = new Date(2026, 10, 12).getTime()
    expect(formatBatchDate(createdAt, now)).toBe('11 月 12 日创建')
  })

  it('includes the year for dates from a previous year', () => {
    const createdAt = new Date(2025, 4, 30).getTime()
    expect(formatBatchDate(createdAt, now)).toBe('2025 年 5 月 30 日创建')
  })
})
