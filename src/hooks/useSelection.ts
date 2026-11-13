import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  createSelection,
  neighborId,
  type SelectionModel,
  type ToggleOptions
} from '../state/selection'

export interface SelectionApi {
  orderedIds: number[]
  selected: Set<number>
  anchor: number | null
  /** Monotonic render-bump primitive; see SelectionModel.getNonce. */
  nonce: number
  toggle(id: number, options?: ToggleOptions): void
  selectAll(): void
  clear(): void
  /** Move the single selection to the neighbor slot, clamped at the ends. */
  navigate(dir: -1 | 1): void
  /**
   * Select this id once after the next view change (e.g. the photo that shifts
   * into the anchor slot after assign/trash + refresh); null clears a pending pin.
   */
  pinSelection(id: number | null): void
}

// Thin React wrapper around the DOM-free pure model. A new orderedIds array
// identity (view switch or refresh) recreates the model, so selection never
// leaks across views; onChange mirrors the resulting ids into the store.
export function useSelection(
  orderedIds: number[],
  onChange?: (ids: number[]) => void
): SelectionApi {
  const idsRef = useRef(orderedIds)
  const modelRef = useRef<SelectionModel | null>(null)
  if (modelRef.current === null || idsRef.current !== orderedIds) {
    idsRef.current = orderedIds
    modelRef.current = createSelection(orderedIds)
  }
  const model = modelRef.current

  const [, bump] = useReducer((n: number) => n + 1, 0)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const pendingPinRef = useRef<number | null>(null)

  // The render-phase recreation above clears selection; mirror that reset once
  // committed so store consumers see the empty selection — unless a pin was
  // requested (post-classify landing), in which case select the pinned photo.
  useEffect(() => {
    const pinned = pendingPinRef.current
    pendingPinRef.current = null
    if (pinned !== null && orderedIds.includes(pinned)) {
      model.toggle(pinned)
      emit()
    } else {
      onChangeRef.current?.([])
    }
  }, [orderedIds])

  const emit = useCallback(() => {
    bump()
    onChangeRef.current?.([...model.selected])
  }, [model])

  const toggle = useCallback(
    (id: number, options?: ToggleOptions) => {
      model.toggle(id, options)
      emit()
    },
    [model, emit]
  )

  const selectAll = useCallback(() => {
    model.selectAll()
    emit()
  }, [model, emit])

  const clear = useCallback(() => {
    model.clear()
    emit()
  }, [model, emit])

  const navigate = useCallback(
    (dir: -1 | 1) => {
      const nextId = neighborId(orderedIds, model.anchor, dir)
      if (nextId !== null) {
        model.toggle(nextId)
        emit()
      }
    },
    [model, emit, orderedIds]
  )

  const pinSelection = useCallback((id: number | null) => {
    pendingPinRef.current = id
  }, [])

  return {
    orderedIds,
    selected: model.selected,
    anchor: model.anchor,
    // Primitive read after every bump() re-render; cellProps consumers pass it
    // through so react-window's shallow cellProps comparison always sees a change.
    nonce: model.getNonce(),
    toggle,
    selectAll,
    clear,
    navigate,
    pinSelection
  }
}
