import { BrowserWindow, ipcMain } from 'electron'
import {
  BLINK_MAX_CONCURRENCY,
  BLINK_REPLY_CHANNEL,
  BLINK_REQUEST_CHANNEL,
  BLINK_TIMEOUT_MS,
  BlinkThumbnailError,
  isDecodeReply,
  normalizeBlinkError,
  withTimeout,
  type BlinkDecodeRequest
} from '../shared/blinkProtocol'

// Ruling 18: Electron 44's main-process nativeImage cannot decode webp, so a hidden
// sandboxed BrowserWindow runs a bundled Blink helper that fetches the registered
// source over selight://photo/<id>, decodes with createImageBitmap and returns a
// width-320 JPEG. Every failure is normalized and the caller (ensureThumbnail)
// degrades to the existing placeholder + sidecar path, so the MediaQueue never stalls.

export interface RegisteredPhoto {
  id: number
}

export interface BlinkThumbnailConfig {
  // Live DB whitelist: only rows registered in photos (and not marked missing) decode.
  lookupPhoto: (absPath: string) => RegisteredPhoto | null
  // Absolute path to the built helper preload bundle.
  preloadPath: string
  // loadFile path (production) or loadURL target (development) for the helper page.
  helperPage: string
}

let config: BlinkThumbnailConfig | null = null

let helperWindow: BrowserWindow | null = null
let loading: Promise<BrowserWindow> | null = null
let replyListenerAttached = false
let requestSeq = 0

interface Pending {
  resolve: (jpeg: Buffer) => void
  reject: (err: Error) => void
}
const pending = new Map<number, Pending>()

// Local concurrency gate aligned with the MediaQueue concurrency of 2.
let activeSlots = 0
const waiters: Array<{ start: () => void; reject: (err: Error) => void }> = []

export function configureBlinkThumbnail(opts: BlinkThumbnailConfig): void {
  config = opts
}

function failAllPending(code: Parameters<typeof normalizeBlinkError>[0], message: string): void {
  for (const [id, entry] of pending) {
    entry.reject(normalizeBlinkError(code, message))
    pending.delete(id)
  }
  while (waiters.length > 0) {
    waiters.pop()!.reject(normalizeBlinkError(code, message))
  }
}

function attachReplyListener(win: BrowserWindow): void {
  if (!replyListenerAttached) {
    ipcMain.on(BLINK_REPLY_CHANNEL, (event, payload: unknown) => {
      // Deep-forgery guard: only the singleton helper's own webContents may reply.
      if (event.sender !== helperWindow?.webContents) return
      if (!isDecodeReply(payload)) return
      const entry = pending.get(payload.requestId)
      if (entry === undefined) return
      pending.delete(payload.requestId)
      if (!payload.ok) {
        entry.reject(normalizeBlinkError('BLINK_DECODE', payload.error ?? 'helper failed'))
        return
      }
      const bytes = Buffer.from(payload.jpeg!)
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        entry.reject(
          normalizeBlinkError('BLINK_BAD_REPLY', 'helper returned bytes without a JPEG SOI marker')
        )
        return
      }
      entry.resolve(bytes)
    })
    replyListenerAttached = true
  }

  win.webContents.on('render-process-gone', () => {
    failAllPending('BLINK_NO_HELPER', 'helper render process gone')
    if (!win.isDestroyed()) win.destroy()
  })
  win.on('closed', () => {
    if (helperWindow === win) {
      helperWindow = null
      loading = null
    }
    failAllPending('BLINK_NO_HELPER', 'helper window closed')
  })
}

async function getHelperWindow(): Promise<BrowserWindow> {
  if (helperWindow && !helperWindow.isDestroyed()) return helperWindow
  if (loading) return loading

  loading = (async () => {
    if (config === null) {
      throw normalizeBlinkError('BLINK_NOT_CONFIGURED', 'decoder has no configuration')
    }
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      title: 'selight-blink-helper',
      webPreferences: {
        // Entries pass the built paths explicitly: shared chunks live under
        // out/main/chunks/, so a __dirname-relative path here would be unreliable.
        preload: config.preloadPath,
        // Tightest renderer posture, same as the main window.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden window is backgrounded and Chromium would throttle its task queue
        // to ~1Hz, adding ~1s per decode; the helper is a worker, not a visible tab.
        backgroundThrottling: false
      }
    })
    attachReplyListener(win)
    try {
      // Anything with a scheme (dev http server or selight://) needs loadURL; a bare
      // filesystem path uses loadFile.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(config.helperPage)) {
        await win.loadURL(config.helperPage)
      } else {
        await win.loadFile(config.helperPage)
      }
    } catch (err) {
      if (!win.isDestroyed()) win.destroy()
      throw normalizeBlinkError('BLINK_NO_HELPER', 'helper page failed to load', err)
    }
    helperWindow = win
    return win
  })()

  try {
    return await loading
  } catch (err) {
    loading = null
    throw err instanceof BlinkThumbnailError
      ? err
      : normalizeBlinkError('BLINK_NO_HELPER', 'helper window unavailable', err)
  }
}

function runSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      activeSlots += 1
      task()
        .then(resolve, reject)
        .finally(() => {
          // Clamp: closeBlinkHelper resets the counter while tasks may still be settling.
          activeSlots = Math.max(0, activeSlots - 1)
          waiters.shift()?.start()
        })
    }
    if (activeSlots < BLINK_MAX_CONCURRENCY) start()
    else waiters.push({ start, reject })
  })
}

async function sendDecode(photo: RegisteredPhoto, absPath: string): Promise<Buffer> {
  const win = await getHelperWindow()
  const requestId = ++requestSeq
  const request: BlinkDecodeRequest = { requestId, photoId: photo.id, absPath }
  const reply = new Promise<Buffer>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
  })
  try {
    // Inside the try: a synchronous send throw (e.g. window destroyed first) must not
    // leak the pending entry.
    win.webContents.send(BLINK_REQUEST_CHANNEL, request)
    return await withTimeout(
      () => reply,
      BLINK_TIMEOUT_MS,
      `webp decode request ${requestId}`
    )
  } catch (err) {
    // A late reply is ignored via the pending-map correlation.
    pending.delete(requestId)
    throw err instanceof BlinkThumbnailError
      ? err
      : normalizeBlinkError('BLINK_DECODE', 'helper request failed', err)
  }
}

// Decodes one webp via the Blink helper and returns the finished width-320 JPEG buffer.
// Rejects with a coded BlinkThumbnailError on every failure mode.
export async function decodeWebpThumbnail(absPath: string): Promise<Buffer> {
  if (config === null) {
    throw normalizeBlinkError('BLINK_NOT_CONFIGURED', 'decoder has no configuration')
  }
  const photo = config.lookupPhoto(absPath)
  if (photo === null) {
    throw normalizeBlinkError(
      'BLINK_NOT_WHITELISTED',
      `path is not a registered, present photo: ${absPath}`
    )
  }
  return runSlot(() => sendDecode(photo, absPath))
}

// Lifecycle hook for will-quit / main-window close: reject anything still waiting
// and destroy the hidden window so the app can exit with no leftover renderer.
export function closeBlinkHelper(): void {
  loading = null
  failAllPending('BLINK_NO_HELPER', 'helper shut down')
  activeSlots = 0
  const win = helperWindow
  helperWindow = null
  if (win && !win.isDestroyed()) win.destroy()
}
