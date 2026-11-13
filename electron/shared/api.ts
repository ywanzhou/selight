// The single window.selight contract shared by main (handler registration), preload
// (contextBridge wrapper) and renderer (typed calls). Type-only imports are erased at
// build time, so this module carries no runtime dependency and is safe to share across
// the main/preload/renderer bundles and the bare-node Vitest suite.
import type { BatchRow } from '../domain/batches'
import type { FolderRow } from '../domain/folders'
import type { PhotoRow, View } from '../domain/photos'

export type { BatchRow, FolderRow, PhotoRow, View }

export type MediaKind = 'thumb' | 'photo'

export interface Counts {
  total: number
  inbox: number
  folder: number
  trash: number
}

// First-paint bundle returned when opening a batch. Photos are the default inbox view;
// later navigation re-pulls a single view through listView (the store's refresh path).
export interface BatchState {
  batch: BatchRow
  folders: FolderRow[]
  counts: Counts
  photos: PhotoRow[]
}

export interface ImportResult {
  added: number
  updated: number
  missing: number
  /** Skipped unreadable files/directories, surfaced to the renderer instead of aborting. */
  failures: string[]
}

// Request/response surface, wrapped 1:1 by ipcRenderer.invoke and implemented by the
// pure createHandlers factory (which has no webContents and therefore cannot push).
// Batch-scoped calls take batchId explicitly: the factory holds no mutable "current
// batch", keeping it pure and per-batch isolation testable. exportBatch is deliberately
// absent — Task 17 adds the exporter, its handler and progress event.
export interface SelightHandlers {
  listBatches(): Promise<BatchRow[]>
  createBatch(name?: string): Promise<BatchRow>
  openBatch(batchId: number): Promise<BatchState>

  listFolders(batchId: number): Promise<FolderRow[]>
  createFolder(batchId: number, name: string): Promise<FolderRow>
  renameFolder(folderId: number, name: string): Promise<void>
  deleteFolder(folderId: number): Promise<number>

  importDirectory(batchId: number, rootPath: string): Promise<ImportResult>
  listView(batchId: number, view: View): Promise<PhotoRow[]>
  counts(batchId: number): Promise<Counts>
  mediaUrl(photoId: number, kind: MediaKind): Promise<string>
  markSelection(ids: number[]): Promise<void>

  assign(photoIds: number[], folderId: number): Promise<number>
  trash(photoIds: number[]): Promise<number>
  restore(photoIds: number[]): Promise<number>
  undo(batchId: number): Promise<boolean>
}

// Full window.selight surface: the invoke handlers plus the two renderer-only
// capabilities that cannot live in the pure SelightHandlers factory (no Electron
// import there, so its contract still runs under bare Node in Vitest).
export interface SelightApi extends SelightHandlers {
  // Native directory picker; null when the user cancels. Sandboxed renderers cannot
  // call dialog themselves, so this is handled directly in main, outside createHandlers.
  pickDirectory(): Promise<string | null>
  // Subscribe to the DB-corruption-recovery notice; calling the returned function
  // removes the listener.
  onDbRecovered(cb: () => void): () => void
}

// Channel names shared by preload (invoke/on) and main (handle/send), so they cannot drift.
export const IPC_CHANNELS = {
  batchList: 'selight:batch:list',
  batchCreate: 'selight:batch:create',
  batchOpen: 'selight:batch:open',
  folderList: 'selight:folder:list',
  folderCreate: 'selight:folder:create',
  folderRename: 'selight:folder:rename',
  folderDelete: 'selight:folder:delete',
  photoImport: 'selight:photo:import',
  photoListView: 'selight:photo:list-view',
  photoCounts: 'selight:photo:counts',
  photoMediaUrl: 'selight:photo:media-url',
  photoMarkSelection: 'selight:photo:mark-selection',
  classifyAssign: 'selight:classify:assign',
  classifyTrash: 'selight:classify:trash',
  classifyRestore: 'selight:classify:restore',
  classifyUndo: 'selight:classify:undo',
  // Main-only dialog invoke; deliberately absent from SelightHandlers/createHandlers.
  dialogPickDirectory: 'selight:dialog:pick-directory',
  // Main → renderer notice only; no invoke handler is registered for this channel.
  dbRecovered: 'selight:db:recovered'
} as const
