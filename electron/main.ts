import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { exiftool } from 'exiftool-vendored'
import { openDatabase } from './db/schema'
import { ExiftoolReader } from './media/rawPreview'
import { createThumbnailQueue } from './media/thumbnails'
// Side-effect import: registers the selight scheme as privileged before app ready.
import { registerMediaProtocol } from './media/protocol'
import { createHandlers } from './ipc'
import { IPC_CHANNELS, type MediaKind, type View } from './shared/api'

let mainWindow: BrowserWindow | null = null
let db: Database | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    title: '择影',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Ruling 8: tightest renderer posture. The preload only uses contextBridge/ipcRenderer.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    console.log('[selight] ready-to-show, window title:', win.getTitle())
    win.show()
  })

  // HMR URL in development, built file in production.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const { db: openedDb, recovered } = openDatabase(path.join(userData, 'selight.db'))
  db = openedDb

  const thumbDir = path.join(userData, 'thumbnails')
  const previewDir = path.join(userData, 'previews')
  fs.mkdirSync(thumbDir, { recursive: true })
  fs.mkdirSync(previewDir, { recursive: true })
  const roots = { thumbDir, previewDir }

  registerMediaProtocol(db, roots)

  const exifReader = new ExiftoolReader()
  const thumbQueue = createThumbnailQueue(db, roots, exifReader)
  const handlers = createHandlers({ db, thumbQueue, roots, exifReader })

  ipcMain.handle(IPC_CHANNELS.batchList, () => handlers.listBatches())
  ipcMain.handle(IPC_CHANNELS.batchCreate, (_event, name?: string) =>
    handlers.createBatch(name)
  )
  ipcMain.handle(IPC_CHANNELS.batchOpen, (_event, batchId: number) =>
    handlers.openBatch(batchId)
  )

  ipcMain.handle(IPC_CHANNELS.folderList, (_event, batchId: number) =>
    handlers.listFolders(batchId)
  )
  ipcMain.handle(
    IPC_CHANNELS.folderCreate,
    (_event, batchId: number, name: string) => handlers.createFolder(batchId, name)
  )
  ipcMain.handle(
    IPC_CHANNELS.folderRename,
    (_event, folderId: number, name: string) => handlers.renameFolder(folderId, name)
  )
  ipcMain.handle(IPC_CHANNELS.folderDelete, (_event, folderId: number) =>
    handlers.deleteFolder(folderId)
  )

  ipcMain.handle(
    IPC_CHANNELS.photoImport,
    (_event, batchId: number, rootPath: string) =>
      handlers.importDirectory(batchId, rootPath)
  )
  ipcMain.handle(
    IPC_CHANNELS.photoListView,
    (_event, batchId: number, view: View) => handlers.listView(batchId, view)
  )
  ipcMain.handle(IPC_CHANNELS.photoCounts, (_event, batchId: number) =>
    handlers.counts(batchId)
  )
  ipcMain.handle(
    IPC_CHANNELS.photoMediaUrl,
    (_event, photoId: number, kind: MediaKind) => handlers.mediaUrl(photoId, kind)
  )
  ipcMain.handle(IPC_CHANNELS.photoMarkSelection, (_event, ids: number[]) =>
    handlers.markSelection(ids)
  )

  ipcMain.handle(
    IPC_CHANNELS.classifyAssign,
    (_event, photoIds: number[], folderId: number) =>
      handlers.assign(photoIds, folderId)
  )
  ipcMain.handle(IPC_CHANNELS.classifyTrash, (_event, photoIds: number[]) =>
    handlers.trash(photoIds)
  )
  ipcMain.handle(IPC_CHANNELS.classifyRestore, (_event, photoIds: number[]) =>
    handlers.restore(photoIds)
  )
  ipcMain.handle(IPC_CHANNELS.classifyUndo, (_event, batchId: number) =>
    handlers.undo(batchId)
  )

  mainWindow = createWindow()
  if (recovered) {
    // Wait until the renderer is listening so the corruption notice is not lost.
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.send(IPC_CHANNELS.dbRecovered, {
        message: 'selight.db was corrupt and has been rebuilt empty'
      })
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  // Deterministic shutdown: close the SQLite handle and release the ExifTool child.
  try {
    db?.close()
  } catch (err) {
    console.error('[selight] database close failed', err)
  }
  exiftool.end().catch((err: unknown) => {
    console.error('[selight] exiftool shutdown failed', err)
  })
})
