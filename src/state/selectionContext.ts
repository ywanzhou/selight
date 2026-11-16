import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactNode
} from 'react'
import { useSelection, type SelectionApi } from '../hooks/useSelection'
import { useAppStore } from './store'

// The selection model has a single owner: this provider, mounted once per open
// batch in the shell. ThumbPane, PreviewPane and useShortcuts read and mutate
// the same instance, so consumers never wait on the one-commit-behind store
// mirror; the mirror still exists via setSelection for cross-cutting state.
const SelectionContext = createContext<SelectionApi | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const { state, setSelection } = useAppStore()
  // Memoized identity: only a real refresh/view switch (new photos array) may
  // recreate the model, never an unrelated re-render.
  const orderedIds = useMemo(() => state.photos.map((p) => p.id), [state.photos])
  const selection = useSelection(orderedIds, setSelection)
  return createElement(SelectionContext.Provider, { value: selection }, children)
}

export function useSelectionContext(): SelectionApi {
  const ctx = useContext(SelectionContext)
  if (!ctx) {
    throw new Error('useSelectionContext must be used inside <SelectionProvider>')
  }
  return ctx
}
