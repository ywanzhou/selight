// Pure multi-selection model over an ordered view of photo ids. No React or DOM
// imports by design: the whole contract is exercised under bare Node in
// tests/renderer/selection.test.ts, and useSelection is a thin React wrapper.

export interface ToggleOptions {
  ctrl?: boolean
  shift?: boolean
}

export interface SelectionModel {
  readonly orderedIds: readonly number[]
  readonly selected: Set<number>
  readonly anchor: number | null
  /** Monotonic mutation counter; lets React consumers break shallow memoization. */
  getNonce(): number
  toggle(id: number, options?: ToggleOptions): void
  selectAll(): void
  clear(): void
}

/** Neighbor the selection should move to from anchorId; clamps at both ends. */
export function neighborId(
  orderedIds: readonly number[],
  anchorId: number | null,
  dir: -1 | 1
): number | null {
  if (orderedIds.length === 0) return null
  const index = anchorId === null ? -1 : orderedIds.indexOf(anchorId)
  if (index === -1) {
    // No anchor (empty selection or a stale one after a view switch): enter the
    // list from the nearest end instead of jumping to a middle slot.
    return dir === 1 ? orderedIds[0] : orderedIds[orderedIds.length - 1]
  }
  const next = Math.min(orderedIds.length - 1, Math.max(0, index + dir))
  return orderedIds[next]
}

/**
 * After actedIds leave the view, pick the remaining photo that occupies the
 * anchor's old slot, or the last remaining photo when the tail was acted on.
 * Returns null when the view is left empty.
 */
export function nextSelectionId(
  orderedIds: readonly number[],
  actedIds: readonly number[],
  anchorId: number | null
): number | null {
  const acted = new Set(actedIds)
  const remaining = orderedIds.filter((id) => !acted.has(id))
  if (remaining.length === 0) return null
  const anchorIndex = anchorId === null ? -1 : orderedIds.indexOf(anchorId)
  if (anchorIndex === -1) return remaining[0]
  return remaining[Math.min(anchorIndex, remaining.length - 1)]
}

export function createSelection(orderedIds: readonly number[]): SelectionModel {
  const selected = new Set<number>()
  let anchor: number | null = null
  let nonce = 0

  function indexOf(id: number): number {
    return orderedIds.indexOf(id)
  }

  function toggle(id: number, options: ToggleOptions = {}): void {
    // Unconditional bump: consumers rely on the nonce changing on every call,
    // even when the resulting membership is identical.
    nonce += 1
    const clicked = indexOf(id)
    if (clicked === -1) return

    if (options.shift) {
      const anchorIndex = anchor === null ? -1 : indexOf(anchor)
      if (anchorIndex === -1) {
        // No usable anchor (never set, or stale relative to this view): range
        // from the first id and treat the first id as the anchor.
        selected.clear()
        for (let i = 0; i <= clicked; i++) selected.add(orderedIds[i])
        anchor = orderedIds[0]
        return
      }
      const [from, to] =
        anchorIndex <= clicked
          ? [anchorIndex, clicked]
          : [clicked, anchorIndex]
      selected.clear()
      for (let i = from; i <= to; i++) selected.add(orderedIds[i])
      // The anchor is the range origin and does not move on shift-click.
      return
    }

    if (options.ctrl) {
      if (selected.has(id)) {
        selected.delete(id)
      } else {
        selected.add(id)
        // Anchor follows the newest member of the selection.
        anchor = id
      }
      return
    }

    selected.clear()
    selected.add(id)
    anchor = id
  }

  function selectAll(): void {
    nonce += 1
    for (const id of orderedIds) selected.add(id)
    if (anchor === null && orderedIds.length > 0) anchor = orderedIds[0]
  }

  function clear(): void {
    nonce += 1
    selected.clear()
    anchor = null
  }

  return {
    orderedIds,
    selected,
    get anchor() {
      return anchor
    },
    getNonce: () => nonce,
    toggle,
    selectAll,
    clear
  }
}
