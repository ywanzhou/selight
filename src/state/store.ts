import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
  type ReactNode
} from 'react'
import type {
  BatchRow,
  BatchState,
  Counts,
  FolderRow,
  ImportResult,
  PhotoRow,
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
  | { type: 'loading'; loading: boolean }

const initialState: AppState = {
  batches: [],
  batchId: null,
  view: { kind: 'inbox' },
  selection: [],
  folders: [],
  photos: [],
  counts: null,
  loading: true
}

function reducer(state: AppState, action: Action): AppState {
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
        loading: false
      }
    case 'refreshed':
      return {
        ...state,
        view: action.view,
        photos: action.photos,
        folders: action.folders,
        counts: action.counts
      }
    case 'loading':
      return { ...state, loading: action.loading }
    default:
      return state
  }
}

export interface AppStore {
  state: AppState
  /** Re-pull listView/counts/listFolders for the current batch+view. */
  refresh(): Promise<void>
  openBatch(batchId: number): Promise<void>
  createBatch(): Promise<void>
  /** Open the native directory picker and import its photos; null when canceled. */
  importDirectory(): Promise<ImportResult | null>
}

const StoreContext = createContext<AppStore | null>(null)

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  async function refresh() {
    if (state.batchId === null) return
    const batchId = state.batchId
    const view = state.view
    const [photos, counts, folders] = await Promise.all([
      window.selight.listView(batchId, view),
      window.selight.counts(batchId),
      window.selight.listFolders(batchId)
    ])
    dispatch({ type: 'refreshed', view, photos, counts, folders })
  }

  async function openBatch(batchId: number) {
    dispatch({ type: 'loading', loading: true })
    try {
      const opened = await window.selight.openBatch(batchId)
      dispatch({ type: 'opened', state: opened })
      // openBatch touches last_opened_at, so re-pull for correct dropdown ordering.
      dispatch({ type: 'batches', batches: await window.selight.listBatches() })
    } finally {
      dispatch({ type: 'loading', loading: false })
    }
  }

  async function createBatch() {
    const batch = await window.selight.createBatch()
    await openBatch(batch.id)
  }

  async function importDirectory(): Promise<ImportResult | null> {
    if (state.batchId === null) return null
    const rootPath = await window.selight.pickDirectory()
    if (!rootPath) return null
    const result = await window.selight.importDirectory(state.batchId, rootPath)
    await refresh()
    return result
  }

  // First paint: list batches and open the most recent (listBatches is
  // last_opened_at DESC); an empty list leaves the empty state on screen.
  useEffect(() => {
    let alive = true
    void (async () => {
      const batches = await window.selight.listBatches()
      if (!alive) return
      dispatch({ type: 'batches', batches })
      if (batches[0]) {
        const opened = await window.selight.openBatch(batches[0].id)
        if (alive) dispatch({ type: 'opened', state: opened })
      } else {
        dispatch({ type: 'loading', loading: false })
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const store: AppStore = { state, refresh, openBatch, createBatch, importDirectory }
  return createElement(StoreContext.Provider, { value: store }, children)
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAppStore must be used inside <AppStoreProvider>')
  return store
}
