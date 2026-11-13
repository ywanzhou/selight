import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  createSelection,
  type SelectionModel,
  type ToggleOptions
} from '../state/selection'

// Thin React wrapper around the DOM-free pure model. A new orderedIds array
// identity (view switch or refresh) recreates the model, so selection never
// leaks across views; onChange mirrors the resulting ids into the store.
export function useSelection(
  orderedIds: number[],
  onChange?: (ids: number[]) => void
) {
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

  // The render-phase recreation above clears selection; mirror that reset once
  // committed so store consumers (PreviewPane, Task 14) see the empty selection.
  useEffect(() => {
    onChangeRef.current?.([])
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

  return {
    selected: model.selected,
    anchor: model.anchor,
    // Primitive read after every bump() re-render; cellProps consumers pass it
    // through so react-window's shallow cellProps comparison always sees a change.
    nonce: model.getNonce(),
    toggle,
    selectAll,
    clear
  }
}
