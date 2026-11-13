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
  toggle(id: number, options?: ToggleOptions): void
  selectAll(): void
  clear(): void
}

export function createSelection(orderedIds: readonly number[]): SelectionModel {
  const selected = new Set<number>()
  let anchor: number | null = null

  function indexOf(id: number): number {
    return orderedIds.indexOf(id)
  }

  function toggle(id: number, options: ToggleOptions = {}): void {
    const clicked = indexOf(id)
    if (clicked === -1) return

    if (options.shift) {
      const start = anchor === null ? 0 : indexOf(anchor)
      const [from, to] = start <= clicked ? [start, clicked] : [clicked, start]
      selected.clear()
      for (let i = from; i <= to; i++) selected.add(orderedIds[i])
      // Without a prior anchor the range starts at the first visible id.
      if (anchor === null) anchor = orderedIds[0]
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
    for (const id of orderedIds) selected.add(id)
    if (anchor === null && orderedIds.length > 0) anchor = orderedIds[0]
  }

  function clear(): void {
    selected.clear()
    anchor = null
  }

  return { orderedIds, selected, get anchor() { return anchor }, toggle, selectAll, clear }
}
