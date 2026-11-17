import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type SelightApi } from './shared/api'

// Sandbox-safe: only contextBridge and ipcRenderer are touched (electron-vite bundles
// this file). No Node APIs, so it runs with sandbox: true + contextIsolation: true.
const api: SelightApi = {
  listBatches: () => ipcRenderer.invoke(IPC_CHANNELS.batchList),
  createBatch: (name) => ipcRenderer.invoke(IPC_CHANNELS.batchCreate, name),
  deleteBatch: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.batchDelete, batchId),
  renameBatch: (batchId, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.batchRename, batchId, name),
  openBatch: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.batchOpen, batchId),

  listFolders: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.folderList, batchId),
  createFolder: (batchId, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.folderCreate, batchId, name),
  renameFolder: (folderId, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.folderRename, folderId, name),
  deleteFolder: (folderId) => ipcRenderer.invoke(IPC_CHANNELS.folderDelete, folderId),

  importDirectory: (batchId, rootPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.photoImport, batchId, rootPath),
  listView: (batchId, view) =>
    ipcRenderer.invoke(IPC_CHANNELS.photoListView, batchId, view),
  counts: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.photoCounts, batchId),
  mediaUrl: (photoId, kind) =>
    ipcRenderer.invoke(IPC_CHANNELS.photoMediaUrl, photoId, kind),
  markSelection: (ids) => ipcRenderer.invoke(IPC_CHANNELS.photoMarkSelection, ids),

  assign: (photoIds, folderId) =>
    ipcRenderer.invoke(IPC_CHANNELS.classifyAssign, photoIds, folderId),
  trash: (photoIds) => ipcRenderer.invoke(IPC_CHANNELS.classifyTrash, photoIds),
  restore: (photoIds) => ipcRenderer.invoke(IPC_CHANNELS.classifyRestore, photoIds),
  unassign: (photoIds) => ipcRenderer.invoke(IPC_CHANNELS.classifyUnassign, photoIds),
  undo: (batchId) => ipcRenderer.invoke(IPC_CHANNELS.classifyUndo, batchId),

  exportBatch: (batchId, outputDir) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportBatch, batchId, outputDir),

  getSession: () => ipcRenderer.invoke(IPC_CHANNELS.sessionGet),
  saveSession: (state) => ipcRenderer.invoke(IPC_CHANNELS.sessionSave, state),

  // Renderer-only capability: native dialog handled in main, outside the pure factory.
  pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.dialogPickDirectory),
  pickExportDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.dialogPickExportDirectory),
  openPath: (target) => ipcRenderer.invoke(IPC_CHANNELS.shellOpenPath, target),

  // Main→renderer push. The wrapped unsubscribe removes the exact listener instance.
  onDbRecovered: (cb) => {
    const listener = () => cb()
    ipcRenderer.on(IPC_CHANNELS.dbRecovered, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dbRecovered, listener)
  },

  onExportProgress: (cb) => {
    const listener = (_event: unknown, payload: { done: number; total: number }) => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.exportProgress, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.exportProgress, listener)
  }
}

contextBridge.exposeInMainWorld('selight', api)
