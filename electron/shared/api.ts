// The single window.selight contract shared by main (handler registration), preload
// (contextBridge wrapper) and renderer (typed calls). Type-only imports are erased at
// build time, so this module carries no runtime dependency and is safe to share across
// the main/preload/renderer bundles and the bare-node Vitest suite.
import type { BatchRow } from '../domain/batches'
import type { FolderRow } from '../domain/folders'
import type { PhotoRow, View } from '../domain/photos'
import type { SessionState } from '../session'
import type { ExportResult } from '../exporter'

export type { BatchRow, FolderRow, PhotoRow, View, SessionState, ExportResult }

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

// Main → renderer progress payload for a running export; the channel carries this
// object verbatim and preload re-exposes it through onExportProgress.
export interface ExportProgressEvent {
  done: number
  total: number
}

// Main → renderer: aggregated EnrichmentService progress across all submissions.
export interface EnrichProgressEvent {
  done: number
  total: number
}

// Main → renderer: one media artifact finished generation. ok:false means a
// permanent placeholder was written and no further retry happens automatically.
// kind aligns with the selight:// route hosts (thumb / photo).
export interface MediaReadyEvent {
  id: number
  kind: MediaKind
  ok: boolean
}

// Request/response surface, wrapped 1:1 by ipcRenderer.invoke and implemented by the
// pure createHandlers factory (which has no webContents and therefore cannot push;
// export progress leaves the factory through an injected callback). Batch-scoped calls
// take batchId explicitly: the factory holds no mutable "current batch", keeping it
// pure and per-batch isolation testable.
export interface SelightHandlers {
  listBatches(): Promise<BatchRow[]>
  createBatch(name?: string): Promise<BatchRow>
  /** Hard-delete a batch and all its rows; returns the number of photos removed. */
  deleteBatch(batchId: number): Promise<number>
  renameBatch(batchId: number, name: string): Promise<void>
  openBatch(batchId: number): Promise<BatchState>

  listFolders(batchId: number): Promise<FolderRow[]>
  createFolder(batchId: number, name: string): Promise<FolderRow>
  renameFolder(folderId: number, name: string): Promise<void>
  deleteFolder(folderId: number): Promise<number>

  importDirectory(batchId: number, rootPath: string): Promise<ImportResult>
  /** Abort an in-flight discovery scan and drop queued enrichment work. */
  cancelImport(): Promise<void>
  listView(batchId: number, view: View): Promise<PhotoRow[]>
  counts(batchId: number): Promise<Counts>
  mediaUrl(photoId: number, kind: MediaKind): Promise<string>
  markSelection(ids: number[]): Promise<void>
  /** Clear a placeholder artifact and re-enqueue generation for manual retry. */
  retryMedia(photoId: number, kind: MediaKind): Promise<void>

  assign(photoIds: number[], folderId: number): Promise<number>
  trash(photoIds: number[]): Promise<number>
  restore(photoIds: number[]): Promise<number>
  /** Move assigned folder photos back to the inbox (unassign); one undoable group. */
  unassign(photoIds: number[]): Promise<number>
  undo(batchId: number): Promise<boolean>

  // Copies original folder-photo files into outputDir, one same-named subdir per
  // non-empty live folder. Progress is pushed via the injected onExportProgress seam.
  exportBatch(batchId: number, outputDir: string): Promise<ExportResult>

  // Session restore; the file storage is injected into createHandlers, so the
  // factory stays electron-free and the contract runs under bare Node.
  getSession(): Promise<SessionState | null>
  saveSession(state: SessionState): Promise<void>
}

// Full window.selight surface: the invoke handlers plus the two renderer-only
// capabilities that cannot live in the pure SelightHandlers factory (no Electron
// import there, so its contract still runs under bare Node in Vitest).
export interface SelightApi extends SelightHandlers {
  // Native directory picker; null when the user cancels. Sandboxed renderers cannot
  // call dialog themselves, so this is handled directly in main, outside createHandlers.
  pickDirectory(): Promise<string | null>
  // Picker for the export output directory; also arms the main-side openPath guard.
  pickExportDirectory(): Promise<string | null>
  // Open a path in Explorer/Finder. Main rejects anything outside the chosen export dir.
  openPath(path: string): Promise<void>
  // Subscribe to the DB-corruption-recovery notice; calling the returned function
  // removes the listener.
  onDbRecovered(cb: () => void): () => void
  // Subscribe to export progress while an exportBatch invoke is in flight.
  onExportProgress(cb: (event: ExportProgressEvent) => void): () => void
  // Subscribe to background enrichment progress (aggregated across batches).
  onEnrichProgress(cb: (event: EnrichProgressEvent) => void): () => void
  // Subscribe to per-photo thumbnail readiness for on-demand 404 retries.
  onMediaReady(cb: (event: MediaReadyEvent) => void): () => void
}

// Channel names shared by preload (invoke/on) and main (handle/send), so they cannot drift.
export const IPC_CHANNELS = {
  batchList: 'selight:batch:list',
  batchCreate: 'selight:batch:create',
  batchDelete: 'selight:batch:delete',
  batchRename: 'selight:batch:rename',
  batchOpen: 'selight:batch:open',
  folderList: 'selight:folder:list',
  folderCreate: 'selight:folder:create',
  folderRename: 'selight:folder:rename',
  folderDelete: 'selight:folder:delete',
  photoImport: 'selight:photo:import',
  importCancel: 'selight:import:cancel',
  photoListView: 'selight:photo:list-view',
  photoCounts: 'selight:photo:counts',
  photoMediaUrl: 'selight:photo:media-url',
  photoMarkSelection: 'selight:photo:mark-selection',
  mediaRetry: 'selight:media:retry',
  classifyAssign: 'selight:classify:assign',
  classifyTrash: 'selight:classify:trash',
  classifyRestore: 'selight:classify:restore',
  classifyUnassign: 'selight:classify:unassign',
  classifyUndo: 'selight:classify:undo',
  sessionGet: 'selight:session:get',
  sessionSave: 'selight:session:save',
  // Main-only dialog invoke; deliberately absent from SelightHandlers/createHandlers.
  dialogPickDirectory: 'selight:dialog:pick-directory',
  dialogPickExportDirectory: 'selight:dialog:pick-export-directory',
  shellOpenPath: 'selight:shell:open-path',
  exportBatch: 'selight:export:batch',
  // Main → renderer progress events; no invoke handler is registered for this channel.
  exportProgress: 'selight:export:progress',
  // Main → renderer notice only; no invoke handler is registered for this channel.
  dbRecovered: 'selight:db:recovered',
  // Main → renderer enrichment/media events; push-only, no invoke handler.
  enrichProgress: 'selight:enrich:progress',
  mediaReady: 'selight:media:ready'
} as const
