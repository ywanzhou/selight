import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { exiftool } from 'exiftool-vendored'
import { openDatabase } from './db/schema'
import { ExiftoolReader } from './media/rawPreview'
import { createThumbnailQueue } from './media/thumbnails'
import { createPreviewQueue } from './media/previews'
import { EnrichmentService } from './media/enrich'
import { retryMediaGeneration } from './media/retry'
import { scheduleThumbnailBackfill } from './media/backfill'
import type { MediaQueue } from './media/queue'
// Side-effect import: registers the selight scheme as privileged before app ready.
import { registerMediaProtocol } from './media/protocol'
import { createHandlers } from './ipc'
import { createFileSessionStore } from './sessionStore'
import type { SessionStore } from './session'
import { IPC_CHANNELS, type MediaKind, type SessionState, type View } from './shared/api'

let mainWindow: BrowserWindow | null = null
let db: Database | null = null
let thumbQueue: MediaQueue | null = null
let previewQueue: MediaQueue | null = null
let enrichment: EnrichmentService | null = null
let sessionStore: SessionStore | null = null
let isQuitting = false
// Last directory chosen for export. openPath only opens paths inside this root, so a
// compromised/confused renderer cannot launch arbitrary paths in Explorer/Finder.
let lastExportDir: string | null = null

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

  win.on('closed', () => {
    mainWindow = null
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

  const exifReader = new ExiftoolReader()
  const thumbs = createThumbnailQueue(
    db,
    roots,
    exifReader,
    (id, ok) => {
      mainWindow?.webContents.send(IPC_CHANNELS.mediaReady, { id, kind: 'thumb', ok })
    }
  )
  const previews = createPreviewQueue(
    db,
    roots,
    exifReader,
    (id, ok) => {
      mainWindow?.webContents.send(IPC_CHANNELS.mediaReady, { id, kind: 'photo', ok })
    }
  )
  thumbQueue = thumbs
  previewQueue = previews
  // A 404 on either route enqueues on-demand generation; each queue dedupes
  // rapid repeated requests for the same id.
  registerMediaProtocol(
    db,
    roots,
    (id) => thumbs.enqueue([id]),
    (id) => previews.enqueue([id])
  )
  // Fill missing thumbnails during idle; ordinary enqueue keeps viewport
  // prioritize calls able to overtake this background work.
  scheduleThumbnailBackfill(db, thumbs, roots)
  enrichment = new EnrichmentService(db, exifReader, {
    onProgress: (done, total) => {
      mainWindow?.webContents.send(IPC_CHANNELS.enrichProgress, { done, total })
    }
  })
  sessionStore = createFileSessionStore(path.join(userData, 'session.json'))
  const handlers = createHandlers({
    db,
    thumbQueue,
    enrichment,
    retry: {
      retryThumb: (id) =>
        retryMediaGeneration(roots, 'thumb', id, { thumb: thumbs, photo: previews }),
      retryPreview: (id) =>
        retryMediaGeneration(roots, 'photo', id, { thumb: thumbs, photo: previews })
    },
    mediaRoots: roots,
    sessionStore,
    onExportProgress: (done, total) => {
      mainWindow?.webContents.send(IPC_CHANNELS.exportProgress, { done, total })
    }
  })

  ipcMain.handle(IPC_CHANNELS.batchList, () => handlers.listBatches())
  ipcMain.handle(IPC_CHANNELS.batchCreate, (_event, name?: string) =>
    handlers.createBatch(name)
  )
  ipcMain.handle(IPC_CHANNELS.batchDelete, (_event, batchId: number) =>
    handlers.deleteBatch(batchId)
  )
  ipcMain.handle(
    IPC_CHANNELS.batchRename,
    (_event, batchId: number, name: string) => handlers.renameBatch(batchId, name)
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
  ipcMain.handle(IPC_CHANNELS.importCancel, () => handlers.cancelImport())
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
    IPC_CHANNELS.mediaRetry,
    (_event, photoId: number, kind: MediaKind) => handlers.retryMedia(photoId, kind)
  )
  ipcMain.handle(IPC_CHANNELS.mediaCacheCleanup, () => handlers.cleanupMediaCache())

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
  ipcMain.handle(IPC_CHANNELS.classifyUnassign, (_event, photoIds: number[]) =>
    handlers.unassign(photoIds)
  )
  ipcMain.handle(IPC_CHANNELS.classifyUndo, (_event, batchId: number) =>
    handlers.undo(batchId)
  )

  // Remember the resolved root here too, so openPath stays scoped even if a future
  // caller starts an export without going through the picker.
  ipcMain.handle(
    IPC_CHANNELS.exportBatch,
    async (_event, batchId: number, outputDir: string) => {
      lastExportDir = path.resolve(outputDir)
      return handlers.exportBatch(batchId, outputDir)
    }
  )

  ipcMain.handle(IPC_CHANNELS.sessionGet, () => handlers.getSession())
  ipcMain.handle(IPC_CHANNELS.sessionSave, (_event, state: SessionState) =>
    handlers.saveSession(state)
  )

  // Native dialog stays in main: the sandboxed renderer has no Electron access, and
  // createHandlers is Electron-free so its contract runs under bare Node.
  ipcMain.handle(IPC_CHANNELS.dialogPickDirectory, async () => {
    const options: OpenDialogOptions = { properties: ['openDirectory'] }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.dialogPickExportDirectory, async () => {
    const options: OpenDialogOptions = {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    const picked = result.filePaths[0] ?? null
    if (picked !== null) lastExportDir = path.resolve(picked)
    return picked
  })

  // Containment check: rel === '' is the root itself (打开输出目录); anything containing
  // '..' or resolving to another drive escapes the chosen export directory and is refused.
  ipcMain.handle(IPC_CHANNELS.shellOpenPath, async (_event, target: string) => {
    if (lastExportDir === null) {
      throw new Error('尚未选择导出目录，无法打开路径')
    }
    const resolved = path.resolve(target)
    const rel = path.relative(lastExportDir, resolved)
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new Error(`拒绝打开导出目录之外的路径：${target}`)
    }
    const error = await shell.openPath(resolved)
    if (error) throw new Error(error)
  })

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
}).catch((err: unknown) => {
  // Surface a startup failure instead of leaving the app hanging with no window.
  dialog.showErrorBox(
    '择影启动失败',
    err instanceof Error ? err.stack ?? err.message : String(err)
  )
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// will-quit is synchronous, but ExifTool shutdown is async: prevent the default quit,
// run cleanup, then re-enter quit. The isQuitting guard makes the second pass proceed.
app.on('will-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  void (async () => {
    try {
      // Land any debounced session change before the process exits.
      sessionStore?.flush()
      // Stop starting new background work; in-flight tasks are allowed to finish.
      thumbQueue?.stop()
      previewQueue?.stop()
      enrichment?.stop()
      try {
        db?.close()
      } catch (err) {
        console.error('[selight] database close failed', err)
      }
      // Await so the ExifTool child cannot be orphaned when the process exits.
      await exiftool.end()
    } catch (err) {
      console.error('[selight] shutdown cleanup failed', err)
    } finally {
      app.quit()
    }
  })()
})
