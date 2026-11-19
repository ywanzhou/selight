import { describe, expect, it } from 'vitest'
import {
  createSelection,
  neighborId,
  nextSelectionId,
  sameIdSequence
} from '../../src/state/selection'

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

describe('neighborId', () => {
  it('walks one slot in the requested direction from the anchor', () => {
    expect(neighborId(IDS, 33, 1)).toBe(44)
    expect(neighborId(IDS, 33, -1)).toBe(22)
  })

  it('clamps at both ends instead of wrapping', () => {
    expect(neighborId(IDS, 11, -1)).toBe(11)
    expect(neighborId(IDS, 88, 1)).toBe(88)
  })

  it('picks the first photo going right and the last going left without an anchor', () => {
    expect(neighborId(IDS, null, 1)).toBe(11)
    expect(neighborId(IDS, null, -1)).toBe(88)
  })

  it('returns null on an empty view', () => {
    expect(neighborId([], null, 1)).toBeNull()
    expect(neighborId([], 5, -1)).toBeNull()
  })

  it('treats a stale anchor as no anchor', () => {
    expect(neighborId(IDS, 999, 1)).toBe(11)
  })
})

describe('nextSelectionId', () => {
  it('lands on the photo that shifted into the anchor slot after a single-photo action', () => {
    // Anchor 33 at index 2 leaves; 44 shifts into slot 2.
    expect(nextSelectionId(IDS, [33], 33)).toBe(44)
  })

  it('falls back to the last remaining photo when acting on the tail', () => {
    expect(nextSelectionId(IDS, [88], 88)).toBe(77)
  })

  it('returns null when every photo leaves the view', () => {
    expect(nextSelectionId(IDS, IDS, 33)).toBeNull()
  })

  it('keeps a stable position when other slots are removed too', () => {
    // Anchor 55 (index 4); removing 11 and 55 leaves [22,33,44,66,77,88],
    // slot 4 is now 77.
    expect(nextSelectionId(IDS, [11, 55], 55)).toBe(77)
  })

  it('defaults to the first remaining photo when the anchor is missing', () => {
    expect(nextSelectionId(IDS, [33], null)).toBe(11)
  })
})

describe('sameIdSequence', () => {
  it('treats two distinct arrays with identical ids in order as equal (folder create/rename refresh)', () => {
    expect(sameIdSequence([11, 22, 33], [...IDS.slice(0, 3)])).toBe(true)
  })

  it('returns true for the same reference and for two empty arrays', () => {
    const ref = [11, 22]
    expect(sameIdSequence(ref, ref)).toBe(true)
    expect(sameIdSequence([], [])).toBe(true)
  })

  it('returns false when length differs, including empty versus non-empty', () => {
    expect(sameIdSequence([11, 22], [11])).toBe(false)
    expect(sameIdSequence([], [11])).toBe(false)
  })

  it('returns false for a different element or a reordered sequence', () => {
    expect(sameIdSequence([11, 22, 33], [11, 99, 33])).toBe(false)
    expect(sameIdSequence([11, 22, 33], [33, 22, 11])).toBe(false)
  })
})
