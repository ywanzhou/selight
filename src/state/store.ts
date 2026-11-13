import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode
} from 'react'
import type {
  BatchRow,
  BatchState,
  Counts,
  FolderRow,
  ImportResult,
  PhotoRow,
  SelightApi,
  View
} from '../../electron/shared/api'

export interface AppState {
  batches: BatchRow[]
  batchId: number | null
  view: View
  selection: number[]
  folders: FolderRow[]
  photos: PhotoRow[]
  counts: Counts | null
  loading: boolean
  error: string | null
}

type Action =
  | { type: 'batches'; batches: BatchRow[] }
  | { type: 'opened'; state: BatchState }
  | {
      type: 'refreshed'
      view: View
      photos: PhotoRow[]
      folders: FolderRow[]
      counts: Counts
    }
  | { type: 'selected'; ids: number[] }
  | { type: 'loading'; loading: boolean }
  | { type: 'error'; error: string }

const initialState: AppState = {
  batches: [],
  batchId: null,
  view: { kind: 'inbox' },
  selection: [],
  folders: [],
  photos: [],
  counts: null,
  loading: true,
  error: null
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'batches':
      return { ...state, batches: action.batches }
    case 'opened':
      return {
        ...state,
        batchId: action.state.batch.id,
        view: { kind: 'inbox' },
        selection: [],
        folders: action.state.folders,
        photos: action.state.photos,
        counts: action.state.counts,
        loading: false,
        error: null
      }
    case 'refreshed':
      return {
        ...state,
        view: action.view,
        photos: action.photos,
        folders: action.folders,
        counts: action.counts
      }
    case 'selected':
      // Mirror of the selection model owned by useSelection in ThumbPane.
      return { ...state, selection: action.ids }
    case 'loading':
      return { ...state, loading: action.loading }
    case 'error':
      // Every failure lands here so the shell can never stick on loading=true.
      return { ...state, loading: false, error: action.error }
    default:
      return state
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Injected dependencies let the thunks run under bare Node in Vitest with a fake
// SelightApi; the provider below supplies the real window.selight bridge.
export interface ThunkDeps {
  api: SelightApi
  getState(): AppState
  dispatch(action: Action): void
}

/** Re-pull listView/counts/listFolders for the current batch+view. */
export async function refresh(deps: ThunkDeps): Promise<void> {
  const { batchId, view } = deps.getState()
  if (batchId === null) return
  const [photos, counts, folders] = await Promise.all([
    deps.api.listView(batchId, view),
    deps.api.counts(batchId),
    deps.api.listFolders(batchId)
  ])
  deps.dispatch({ type: 'refreshed', view, photos, counts, folders })
}

export async function openBatch(deps: ThunkDeps, batchId: number): Promise<void> {
  deps.dispatch({ type: 'loading', loading: true })
  try {
    const opened = await deps.api.openBatch(batchId)
    deps.dispatch({ type: 'opened', state: opened })
    // openBatch touches last_opened_at, so re-pull for correct dropdown ordering.
    deps.dispatch({ type: 'batches', batches: await deps.api.listBatches() })
  } finally {
    deps.dispatch({ type: 'loading', loading: false })
  }
}

export async function createBatch(deps: ThunkDeps): Promise<void> {
  const batch = await deps.api.createBatch()
  await openBatch(deps, batch.id)
}

/** Open the native directory picker and import its photos; null when canceled. */
export async function importDirectory(deps: ThunkDeps): Promise<ImportResult | null> {
  const { batchId } = deps.getState()
  if (batchId === null) return null
  const rootPath = await deps.api.pickDirectory()
  if (!rootPath) return null
  const result = await deps.api.importDirectory(batchId, rootPath)
  await refresh(deps)
  return result
}

/**
 * Recovery path after the DB was rebuilt empty: there may be no batch yet, so
 * create one first (createBatch opens it) before importing.
 */
export async function recoveryImport(deps: ThunkDeps): Promise<ImportResult | null> {
  if (deps.getState().batchId === null) {
    await createBatch(deps)
  }
  return importDirectory(deps)
}

/** First-paint chain; owns its try/catch so a reject becomes the error state. */
export async function boot(deps: ThunkDeps): Promise<void> {
  deps.dispatch({ type: 'loading', loading: true })
  try {
    // listBatches is last_opened_at DESC, so index 0 is the most recent batch.
    const batches = await deps.api.listBatches()
    deps.dispatch({ type: 'batches', batches })
    if (batches[0]) {
      const opened = await deps.api.openBatch(batches[0].id)
      deps.dispatch({ type: 'opened', state: opened })
    } else {
      deps.dispatch({ type: 'loading', loading: false })
    }
  } catch (e) {
    deps.dispatch({ type: 'error', error: errorMessage(e) })
  }
}

export interface AppStore {
  state: AppState
  setSelection(ids: number[]): void
  boot(): Promise<void>
  refresh(): Promise<void>
  openBatch(batchId: number): Promise<void>
  createBatch(): Promise<void>
  importDirectory(): Promise<ImportResult | null>
  recoveryImport(): Promise<ImportResult | null>
}

const StoreContext = createContext<AppStore | null>(null)

export function AppStoreProvider({
  api,
  children
}: {
  // Injected as a prop so this module never touches the DOM global itself; main.tsx
  // passes window.selight, and the bare-node thunk tests pass a fake SelightApi.
  api: SelightApi
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(reducer, initialState)
  // Ref keeps async thunks reading the latest state regardless of render closure.
  const stateRef = useRef(state)
  stateRef.current = state
  const depsRef = useRef<ThunkDeps | null>(null)
  if (depsRef.current === null) {
    depsRef.current = {
      api,
      getState: () => stateRef.current,
      dispatch
    }
  }
  const deps = depsRef.current

  useEffect(() => {
    void boot(deps)
  }, [deps])

  const store: AppStore = {
    state,
    setSelection: (ids) => dispatch({ type: 'selected', ids }),
    boot: () => boot(deps),
    refresh: () => refresh(deps),
    openBatch: (batchId) => openBatch(deps, batchId),
    createBatch: () => createBatch(deps),
    importDirectory: () => importDirectory(deps),
    recoveryImport: () => recoveryImport(deps)
  }
  return createElement(StoreContext.Provider, { value: store }, children)
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAppStore must be used inside <AppStoreProvider>')
  return store
}
