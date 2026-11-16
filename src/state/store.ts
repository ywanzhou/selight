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
  ExportResult,
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
      // Mirror of the selection model owned by SelectionProvider/useSelection.
      return { ...state, selection: action.ids }
    case 'loading':
      // Starting a new async chain (boot retry, batch open) clears the previous
      // error so a successful retry cannot leave the shell on the stale ErrorState.
      return action.loading
        ? { ...state, loading: true, error: null }
        : { ...state, loading: false }
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

/** Re-pull listView/counts/listFolders for a batch+view and commit the view switch. */
export async function switchView(deps: ThunkDeps, view: View): Promise<void> {
  const { batchId } = deps.getState()
  if (batchId === null) return
  const [photos, counts, folders] = await Promise.all([
    deps.api.listView(batchId, view),
    deps.api.counts(batchId),
    deps.api.listFolders(batchId)
  ])
  deps.dispatch({ type: 'refreshed', view, photos, counts, folders })
}

/** Re-pull listView/counts/listFolders for the current batch+view. */
export function refresh(deps: ThunkDeps): Promise<void> {
  return switchView(deps, deps.getState().view)
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

/**
 * Export the open batch into an already-picked outputDir. The picker stays in the
 * component (the dialog needs the path for 打开输出目录); progress arrives through
 * the onExportProgress push, not the invoke result.
 */
export async function exportBatch(
  deps: ThunkDeps,
  outputDir: string
): Promise<ExportResult | null> {
  const { batchId } = deps.getState()
  if (batchId === null) return null
  return deps.api.exportBatch(batchId, outputDir)
}

/** First-paint chain; owns its try/catch so a reject becomes the error state. */
export async function boot(deps: ThunkDeps): Promise<void> {
  deps.dispatch({ type: 'loading', loading: true })
  try {
    // listBatches is last_opened_at DESC, so index 0 is the most recent batch.
    const batches = await deps.api.listBatches()
    deps.dispatch({ type: 'batches', batches })

    const session = await deps.api.getSession()
    const sessionBatchId =
      session && batches.some((b) => b.id === session.batchId)
        ? session.batchId
        : null
    const targetId = sessionBatchId ?? batches[0]?.id ?? null

    if (targetId === null) {
      deps.dispatch({ type: 'loading', loading: false })
      return
    }

    const opened = await deps.api.openBatch(targetId)
    deps.dispatch({ type: 'opened', state: opened })

    // Restore the saved view only inside its still-existing batch. A folder view
    // whose folder was deleted falls back to inbox; inbox needs no re-pull because
    // openBatch already returned the inbox photos. The pull is explicit rather than
    // switchView(): the 'opened' dispatch has not rendered yet, so getState() would
    // still read the pre-open batchId and the thunk would no-op.
    if (session && sessionBatchId !== null) {
      const savedView = session.view
      const folderExists =
        savedView.kind !== 'folder' ||
        opened.folders.some((f) => f.id === savedView.folderId)
      if (folderExists && savedView.kind !== 'inbox') {
        const [photos, restoredCounts, restoredFolders] = await Promise.all([
          deps.api.listView(targetId, savedView),
          deps.api.counts(targetId),
          deps.api.listFolders(targetId)
        ])
        deps.dispatch({
          type: 'refreshed',
          view: savedView,
          photos,
          counts: restoredCounts,
          folders: restoredFolders
        })
      }
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
  switchView(view: View): Promise<void>
  openBatch(batchId: number): Promise<void>
  createBatch(): Promise<void>
  importDirectory(): Promise<ImportResult | null>
  recoveryImport(): Promise<ImportResult | null>
  exportBatch(outputDir: string): Promise<ExportResult | null>
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

  // Persist every settled batchId/view change. The loading/error guards skip the
  // pre-hydration null state and failed boots, which must not overwrite a good
  // session; a null batchId writes the null-style state for the empty workspace.
  const { batchId, view, loading, error } = state
  useEffect(() => {
    if (loading || error !== null) return
    void api.saveSession({ batchId, view }).catch(() => undefined)
  }, [api, batchId, view, loading, error])

  const store: AppStore = {
    state,
    setSelection: (ids) => dispatch({ type: 'selected', ids }),
    boot: () => boot(deps),
    refresh: () => refresh(deps),
    switchView: (view) => switchView(deps, view),
    openBatch: (batchId) => openBatch(deps, batchId),
    createBatch: () => createBatch(deps),
    importDirectory: () => importDirectory(deps),
    recoveryImport: () => recoveryImport(deps),
    exportBatch: (outputDir) => exportBatch(deps, outputDir)
  }
  return createElement(StoreContext.Provider, { value: store }, children)
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAppStore must be used inside <AppStoreProvider>')
  return store
}
