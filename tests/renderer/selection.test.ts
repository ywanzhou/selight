import { describe, expect, it } from 'vitest'
import { createSelection } from '../../src/state/selection'

// The selection model is plain TypeScript with no React/DOM imports, so the
// whole multi-select contract runs under bare Node like the store thunks.
// useSelection is a thin React wrapper over this factory (see src/hooks/useSelection.ts).

const IDS = [11, 22, 33, 44, 55, 66, 77, 88]

function ids(model: ReturnType<typeof createSelection>): number[] {
  return [...model.selected]
}

describe('createSelection', () => {
  it('plain click selects only that id and makes it the anchor', () => {
    const sel = createSelection(IDS)
    sel.toggle(33)
    expect(ids(sel)).toEqual([33])
    expect(sel.anchor).toBe(33)

    sel.toggle(77)
    expect(ids(sel)).toEqual([77])
    expect(sel.anchor).toBe(77)
  })

  it('ctrl accumulates ids and moves the anchor to the added id', () => {
    const sel = createSelection(IDS)
    sel.toggle(33)
    sel.toggle(55, { ctrl: true })

    expect(ids(sel).sort((a, b) => a - b)).toEqual([33, 55])
    expect(sel.anchor).toBe(55)
  })

  it('ctrl cancels a membership without moving the anchor', () => {
    const sel = createSelection(IDS)
    sel.toggle(33)
    sel.toggle(55, { ctrl: true })
    sel.toggle(33, { ctrl: true })

    expect(ids(sel)).toEqual([55])
    expect(sel.anchor).toBe(55)
  })

  it('ctrl can remove the last selected id, leaving an empty selection', () => {
    const sel = createSelection(IDS)
    sel.toggle(33)
    sel.toggle(33, { ctrl: true })

    expect(ids(sel)).toEqual([])
    expect(sel.anchor).toBe(33)
  })

  it('shift selects the inclusive range from the anchor to the clicked id', () => {
    const sel = createSelection(IDS)
    sel.toggle(22)
    sel.toggle(66, { shift: true })

    expect(ids(sel)).toEqual([22, 33, 44, 55, 66])
    // The anchor is the range origin and does not move on shift-click.
    expect(sel.anchor).toBe(22)
  })

  it('shift range works backwards and replaces any prior selection', () => {
    const sel = createSelection(IDS)
    sel.toggle(11)
    // ctrl-add moves the anchor to the added id, so the range below starts at 88.
    sel.toggle(88, { ctrl: true })
    sel.toggle(33, { shift: true })

    expect(ids(sel)).toEqual([33, 44, 55, 66, 77, 88])
    expect(sel.anchor).toBe(88)
  })

  it('shift without an anchor ranges from the first id and anchors there', () => {
    const sel = createSelection(IDS)
    sel.toggle(44, { shift: true })

    expect(ids(sel)).toEqual([11, 22, 33, 44])
    expect(sel.anchor).toBe(11)
  })

  it('selectAll selects every id in the current view, preserving the anchor', () => {
    const sel = createSelection(IDS)
    sel.toggle(44)
    sel.selectAll()

    // Set iteration follows insertion order; compare as an unordered membership set.
    expect(ids(sel).sort((a, b) => a - b)).toEqual([...IDS].sort((a, b) => a - b))
    expect(sel.anchor).toBe(44)
  })

  it('selectAll without an anchor anchors the first id', () => {
    const sel = createSelection(IDS)
    sel.selectAll()
    expect(sel.anchor).toBe(11)
  })

  it('clear empties the selection and the anchor', () => {
    const sel = createSelection(IDS)
    sel.toggle(33)
    sel.clear()

    expect(ids(sel)).toEqual([])
    expect(sel.anchor).toBeNull()
  })

  it('ignores ids that are not part of the ordered view', () => {
    const sel = createSelection(IDS)
    sel.toggle(999)
    expect(ids(sel)).toEqual([])
    expect(sel.anchor).toBeNull()

    sel.toggle(33)
    sel.toggle(999, { shift: true })
    expect(ids(sel)).toEqual([33])
  })

  it('starts empty when recreated for a new view (useSelection recreates on orderedIds identity change)', () => {
    const first = createSelection(IDS)
    first.selectAll()
    expect(ids(first)).toHaveLength(IDS.length)

    const next = createSelection([91, 92, 93])
    expect(ids(next)).toEqual([])
    expect(next.anchor).toBeNull()
  })

  it('cancels one id with ctrl after selectAll, without moving the anchor', () => {
    const sel = createSelection(IDS)
    sel.selectAll()
    expect(sel.anchor).toBe(11)

    sel.toggle(33, { ctrl: true })

    expect(ids(sel).sort((a, b) => a - b)).toEqual(IDS.filter((id) => id !== 33))
    expect(sel.anchor).toBe(11)
  })

  it('moves the shift range endpoint on consecutive shift clicks, keeping the anchor', () => {
    const sel = createSelection(IDS)
    sel.toggle(22)
    sel.toggle(44, { shift: true })
    expect(ids(sel)).toEqual([22, 33, 44])

    sel.toggle(66, { shift: true })
    expect(ids(sel)).toEqual([22, 33, 44, 55, 66])
    expect(sel.anchor).toBe(22)
  })
})

describe('createSelection nonce', () => {
  it('starts at 0 for a new model', () => {
    expect(createSelection(IDS).getNonce()).toBe(0)
  })

  it('increments strictly on every mutation', () => {
    const sel = createSelection(IDS)
    let expected = 0
    const step = (fn: () => void) => {
      fn()
      expected += 1
      expect(sel.getNonce()).toBe(expected)
    }

    step(() => sel.toggle(33))
    step(() => sel.toggle(55, { ctrl: true }))
    step(() => sel.toggle(33, { ctrl: true }))
    step(() => sel.toggle(66, { shift: true }))
    step(() => sel.selectAll())
    step(() => sel.clear())
  })

  it('increments even when the operation changes nothing', () => {
    const sel = createSelection(IDS)
    sel.toggle(999)
    expect(sel.getNonce()).toBe(1)

    sel.selectAll()
    sel.selectAll()
    expect(sel.getNonce()).toBe(3)
  })
})
