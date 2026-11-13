import { describe, expect, it, vi } from 'vitest'
import type {
  BatchRow,
  BatchState,
  Counts,
  FolderRow,
  SelightApi
} from '../../electron/shared/api'
import {
  boot,
  createBatch,
  importDirectory,
  openBatch,
  recoveryImport,
  reducer,
  refresh,
  switchView,
  type AppState,
  type ThunkDeps
} from '../../src/state/store'

// The thunks take the SelightApi surface by injection, so the whole store logic
// runs under bare Node: no jsdom, no React render, no new test dependency.

const HANDLER_NAMES = [
  'listBatches',
  'createBatch',
  'openBatch',
  'listFolders',
  'createFolder',
  'renameFolder',
  'deleteFolder',
  'importDirectory',
  'listView',
  'counts',
  'mediaUrl',
  'markSelection',
  'assign',
  'trash',
  'restore',
  'undo',
  'pickDirectory',
  'getSession',
  'saveSession'
] as const

function makeApi(overrides: Partial<Record<keyof SelightApi, unknown>> = {}): SelightApi {
  const base = Object.fromEntries(HANDLER_NAMES.map((n) => [n, vi.fn()])) as Record<
    string,
    ReturnType<typeof vi.fn>
  >
  base.onDbRecovered = vi.fn(() => () => {})
  return { ...base, ...overrides } as unknown as SelightApi
}

function harness(api: SelightApi) {
  let state: AppState = {
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
  const dispatch = vi.fn((action: Parameters<typeof reducer>[1]) => {
    state = reducer(state, action)
  })
  const deps: ThunkDeps = { api, getState: () => state, dispatch }
  return {
    deps,
    get state(): AppState {
      return state
    },
    dispatch
  }
}

const batch: BatchRow = { id: 1, name: '2026-11-13', createdAt: 1, lastOpenedAt: 2 }
const zeroCounts: Counts = { total: 0, inbox: 0, folder: 0, trash: 0 }
const opened: BatchState = { batch, folders: [], counts: zeroCounts, photos: [] }

describe('store boot chain', () => {
  it('settles into the empty state when no batch exists', async () => {
    const api = makeApi({ listBatches: vi.fn(async () => []) })
    const h = harness(api)

    await boot(h.deps)

    expect(h.state.loading).toBe(false)
    expect(h.state.batchId).toBeNull()
    expect(h.state.error).toBeNull()
  })

  it('opens the most recent batch on launch', async () => {
    const listBatches = vi.fn(async () => [batch])
    const open = vi.fn(async () => opened)
    const api = makeApi({ listBatches, openBatch: open })
    const h = harness(api)

    await boot(h.deps)

    expect(h.state.batchId).toBe(1)
    expect(h.state.loading).toBe(false)
    expect(h.state.error).toBeNull()
    expect(h.state.counts).toEqual(zeroCounts)
    // boot inlines the open; it must not re-pull the batch list itself.
    expect(listBatches).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(1)
  })

  it('turns a listBatches reject into the error state instead of eternal loading', async () => {
    const api = makeApi({
      listBatches: vi.fn(async () => {
        throw new Error('db locked')
      })
    })
    const h = harness(api)

    await boot(h.deps)

    expect(h.state.loading).toBe(false)
    expect(h.state.error).toBe('db locked')
    expect(h.state.batchId).toBeNull()
  })

  it('turns an openBatch reject into the error state instead of eternal loading', async () => {
    const api = makeApi({
      listBatches: vi.fn(async () => [batch]),
      openBatch: vi.fn(async () => {
        throw new Error('batch missing')
      })
    })
    const h = harness(api)

    await boot(h.deps)

    expect(h.state.loading).toBe(false)
    expect(h.state.error).toBe('batch missing')
  })

  const batch2: BatchRow = { id: 2, name: 'second', createdAt: 3, lastOpenedAt: 4 }
  const folder: FolderRow = {
    id: 9,
    batchId: 2,
    name: '精选',
    sortOrder: 1,
    createdAt: 1,
    deletedAt: null
  }
  const opened2: BatchState = {
    batch: batch2,
    folders: [folder],
    counts: zeroCounts,
    photos: []
  }

  it('restores the saved batch and its folder view at boot', async () => {
    const listView = vi.fn(async () => [])
    const countsFn = vi.fn(async () => zeroCounts)
    const listFolders = vi.fn(async () => [folder])
    const open = vi.fn(async () => opened2)
    const api = makeApi({
      listBatches: vi.fn(async () => [batch2, batch]),
      openBatch: open,
      getSession: vi.fn(async () => ({
        batchId: 2,
        view: { kind: 'folder', folderId: 9 }
      })),
      listView,
      counts: countsFn,
      listFolders
    })
    const h = harness(api)

    await boot(h.deps)

    // The saved batch wins over the most-recent ordering.
    expect(open).toHaveBeenCalledWith(2)
    expect(h.state.batchId).toBe(2)
    expect(h.state.view).toEqual({ kind: 'folder', folderId: 9 })
    expect(listView).toHaveBeenCalledWith(2, { kind: 'folder', folderId: 9 })
  })

  it('restores a saved trash view at boot', async () => {
    const listView = vi.fn(async () => [])
    const api = makeApi({
      listBatches: vi.fn(async () => [batch2]),
      openBatch: vi.fn(async () => opened2),
      getSession: vi.fn(async () => ({ batchId: 2, view: { kind: 'trash' } })),
      listView,
      counts: vi.fn(async () => zeroCounts),
      listFolders: vi.fn(async () => [folder])
    })
    const h = harness(api)

    await boot(h.deps)

    expect(h.state.view).toEqual({ kind: 'trash' })
    expect(listView).toHaveBeenCalledWith(2, { kind: 'trash' })
  })

  it('falls back to inbox when the saved folder no longer exists', async () => {
    const listView = vi.fn(async () => [])
    const api = makeApi({
      listBatches: vi.fn(async () => [batch2]),
      openBatch: vi.fn(async () => ({ ...opened2, folders: [] })),
      getSession: vi.fn(async () => ({
        batchId: 2,
        view: { kind: 'folder', folderId: 99 }
      })),
      listView
    })
    const h = harness(api)

    await boot(h.deps)

    expect(h.state.view).toEqual({ kind: 'inbox' })
    expect(listView).not.toHaveBeenCalled()
  })

  it('ignores a session whose batch was deleted and opens the most recent batch at inbox', async () => {
    const open = vi.fn(async () => opened)
    const listView = vi.fn(async () => [])
    const api = makeApi({
      listBatches: vi.fn(async () => [batch]),
      openBatch: open,
      getSession: vi.fn(async () => ({ batchId: 99, view: { kind: 'trash' } })),
      listView
    })
    const h = harness(api)

    await boot(h.deps)

    expect(open).toHaveBeenCalledWith(1)
    expect(h.state.batchId).toBe(1)
    expect(h.state.view).toEqual({ kind: 'inbox' })
    expect(listView).not.toHaveBeenCalled()
  })

  it('resets a stale error at boot so a successful retry shows the empty state', async () => {
    const listBatches = vi.fn()
    listBatches
      .mockRejectedValueOnce(new Error('db locked'))
      .mockResolvedValueOnce([])
    const api = makeApi({ listBatches })
    const h = harness(api)

    await boot(h.deps)
    expect(h.state.error).toBe('db locked')
    expect(h.state.loading).toBe(false)

    await boot(h.deps)
    expect(h.state.error).toBeNull()
    expect(h.state.loading).toBe(false)
    expect(h.state.batchId).toBeNull()
  })
})

describe('interactive thunks', () => {
  it('openBatch resets loading in finally and propagates the reject for the caller to alert', async () => {
    const api = makeApi({
      listBatches: vi.fn(async () => [batch]),
      openBatch: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const h = harness(api)

    await expect(openBatch(h.deps, 1)).rejects.toThrow('boom')
    expect(h.state.loading).toBe(false)
    // loading=true was observed before the failure.
    expect(h.dispatch).toHaveBeenCalledWith({ type: 'loading', loading: true })
  })

  it('openBatch success clears a previous error and re-pulls the batch list', async () => {
    const listBatches = vi.fn(async () => [batch])
    const api = makeApi({ listBatches, openBatch: vi.fn(async () => opened) })
    const h = harness(api)
    h.dispatch({ type: 'error', error: 'stale' })

    await openBatch(h.deps, 1)

    expect(h.state.error).toBeNull()
    expect(h.state.batchId).toBe(1)
    expect(listBatches).toHaveBeenCalledTimes(1)
  })

  it('recoveryImport creates a batch first when the rebuilt DB has none, then imports', async () => {
    const create = vi.fn(async () => batch)
    const open = vi.fn(async () => opened)
    const listBatches = vi.fn(async () => [batch])
    const pick = vi.fn(async () => 'E:/photos/wedding')
    const imported = { added: 4, updated: 0, missing: 0, failures: [] }
    const importCall = vi.fn(async () => imported)
    const api = makeApi({
      createBatch: create,
      openBatch: open,
      listBatches,
      pickDirectory: pick,
      importDirectory: importCall,
      listView: vi.fn(async () => []),
      counts: vi.fn(async () => zeroCounts),
      listFolders: vi.fn(async () => [])
    })
    const h = harness(api)
    expect(h.state.batchId).toBeNull()

    const result = await recoveryImport(h.deps)

    expect(create).toHaveBeenCalledTimes(1)
    expect(pick).toHaveBeenCalledTimes(1)
    expect(importCall).toHaveBeenCalledWith(1, 'E:/photos/wedding')
    expect(result).toEqual(imported)
    expect(h.state.batchId).toBe(1)
  })

  it('recoveryImport reuses the open batch without creating one', async () => {
    const create = vi.fn(async () => batch)
    const pick = vi.fn(async () => 'E:/photos')
    const importCall = vi.fn(async () => ({
      added: 1,
      updated: 0,
      missing: 0,
      failures: []
    }))
    const api = makeApi({
      createBatch: create,
      pickDirectory: pick,
      importDirectory: importCall,
      listView: vi.fn(async () => []),
      counts: vi.fn(async () => zeroCounts),
      listFolders: vi.fn(async () => [])
    })
    const h = harness(api)
    h.dispatch({ type: 'opened', state: opened })

    await recoveryImport(h.deps)

    expect(create).not.toHaveBeenCalled()
    expect(importCall).toHaveBeenCalledWith(1, 'E:/photos')
  })

  it('importDirectory returns null without importing when the picker is canceled', async () => {
    const importCall = vi.fn()
    const api = makeApi({
      pickDirectory: vi.fn(async () => null),
      importDirectory: importCall
    })
    const h = harness(api)
    h.dispatch({ type: 'opened', state: opened })

    expect(await importDirectory(h.deps)).toBeNull()
    expect(importCall).not.toHaveBeenCalled()
  })

  it('refresh re-pulls the current view, counts and folders in parallel', async () => {
    const listView = vi.fn(async () => [])
    const counts = vi.fn(async () => zeroCounts)
    const listFolders = vi.fn(async () => [])
    const api = makeApi({ listView, counts, listFolders })
    const h = harness(api)
    h.dispatch({ type: 'opened', state: opened })

    await refresh(h.deps)

    expect(listView).toHaveBeenCalledWith(1, { kind: 'inbox' })
    expect(counts).toHaveBeenCalledWith(1)
    expect(listFolders).toHaveBeenCalledWith(1)
    expect(h.state.photos).toEqual([])
  })

  it('refresh is a no-op without an open batch', async () => {
    const listView = vi.fn()
    const api = makeApi({ listView })
    const h = harness(api)

    await refresh(h.deps)
    expect(listView).not.toHaveBeenCalled()
  })

  it('switchView re-pulls the target view and lands its view/photos in state', async () => {
    const inboxPhoto = { id: 7 }
    const listView = vi.fn(async (_batchId: number, view: { kind: string }) =>
      view.kind === 'inbox' ? [inboxPhoto] : []
    )
    const countsFn = vi.fn(async () => zeroCounts)
    const listFolders = vi.fn(async () => [])
    const api = makeApi({ listView, counts: countsFn, listFolders })
    const h = harness(api)
    h.dispatch({ type: 'opened', state: opened })

    await switchView(h.deps, { kind: 'inbox' })

    expect(listView).toHaveBeenCalledWith(1, { kind: 'inbox' })
    expect(h.state.view).toEqual({ kind: 'inbox' })
    expect(h.state.photos).toEqual([inboxPhoto])
  })

  it('switchView is a no-op without an open batch', async () => {
    const listView = vi.fn()
    const api = makeApi({ listView })
    const h = harness(api)

    await switchView(h.deps, { kind: 'trash' })
    expect(listView).not.toHaveBeenCalled()
  })

  it('createBatch opens the freshly created batch', async () => {
    const create = vi.fn(async () => batch)
    const open = vi.fn(async () => opened)
    const api = makeApi({
      createBatch: create,
      openBatch: open,
      listBatches: vi.fn(async () => [batch])
    })
    const h = harness(api)

    await createBatch(h.deps)

    expect(create).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(1)
    expect(h.state.batchId).toBe(1)
  })
})

describe('reducer', () => {
  it('error always clears loading', () => {
    const loading: AppState = { ...harness(makeApi()).state, loading: true }
    const next = reducer(loading, { type: 'error', error: 'x' })
    expect(next.loading).toBe(false)
    expect(next.error).toBe('x')
  })

  it('returns the same state for unknown actions', () => {
    const state = harness(makeApi()).state
    expect(reducer(state, { type: 'unknown' } as never)).toBe(state)
  })
})
