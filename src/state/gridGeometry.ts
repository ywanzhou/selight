// DOM-free two-column grid geometry, unit-tested under bare Node. The measured
// inner Grid clientWidth is the input: two equal cells plus one gap must
// always fit it.

/**
 * Width of one thumbnail cell for a two-column grid with a single inter-column
 * gap. Floored to whole pixels and clamped at 0, so a scrollbar-squeezed or
 * extremely narrow container can never produce a negative width or NaN.
 */
export function cellWidth(clientWidth: number, gap: number): number {
  if (!Number.isFinite(clientWidth) || !Number.isFinite(gap)) return 0
  return Math.max(0, Math.floor((clientWidth - gap) / 2))
}

/**
 * Row index of a flat photo index inside the column-count grid, or null when
 * there is no anchored photo (index -1/null). A non-positive column count
 * degrades to one photo per row rather than producing NaN or division errors.
 */
export function anchorRowIndex(
  anchorIndex: number | null,
  columnCount: number
): number | null {
  if (anchorIndex === null || anchorIndex < 0) return null
  const columns = columnCount > 0 ? columnCount : 1
  return Math.floor(anchorIndex / columns)
}
