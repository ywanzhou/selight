import { describe, expect, it } from 'vitest'
import { cellWidth } from '../../src/state/gridGeometry'

// DOM-free table tests for the two-column thumbnail grid geometry. The same
// width drives both columns, so 2 cells + one gap must fit clientWidth.

describe('cellWidth', () => {
  it('splits the typical 176px content width into two 83px cells around a 10px gap', () => {
    expect(cellWidth(176, 10)).toBe(83)
  })

  it('shrinks when the classic scrollbar squeezes clientWidth to 160px', () => {
    expect(cellWidth(160, 10)).toBe(75)
  })

  it('floors odd widths so two cells plus the gap never overflow', () => {
    expect(cellWidth(177, 10)).toBe(83)
  })

  it('clamps to zero instead of going negative on extremely narrow widths', () => {
    expect(cellWidth(5, 10)).toBe(0)
    expect(cellWidth(0, 10)).toBe(0)
    expect(cellWidth(-40, 10)).toBe(0)
  })

  it('never returns NaN for non-finite inputs', () => {
    expect(cellWidth(Number.NaN, 10)).toBe(0)
    expect(cellWidth(160, Number.NaN)).toBe(0)
    expect(cellWidth(Number.POSITIVE_INFINITY, 10)).toBe(0)
  })

  it('uses the full width when there is no gap', () => {
    expect(cellWidth(160, 0)).toBe(80)
  })
})
