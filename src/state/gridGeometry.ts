// DOM-free two-column grid geometry, unit-tested under bare Node. The measured
// .thumbs-wrap content width (clientWidth minus its horizontal padding) is the
// input: two equal cells plus one gap must always fit it.

/**
 * Width of one thumbnail cell for a two-column grid with a single inter-column
 * gap. Floored to whole pixels and clamped at 0, so a scrollbar-squeezed or
 * extremely narrow container can never produce a negative width or NaN.
 */
export function cellWidth(clientWidth: number, gap: number): number {
  if (!Number.isFinite(clientWidth) || !Number.isFinite(gap)) return 0
  return Math.max(0, Math.floor((clientWidth - gap) / 2))
}
