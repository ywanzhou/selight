import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  BLINK_REPLY_CHANNEL,
  BLINK_REQUEST_CHANNEL,
  isDecodeRequest,
  type BlinkDecodeRequest
} from './shared/blinkProtocol'

// Sandbox-safe preload for the hidden Blink helper window: only contextBridge and
// ipcRenderer are touched, no Node APIs. The page owns the Blink decode pipeline;
// this bridge only correlates main-process requests with its replies.
export interface SelightBlinkBridge {
  onDecodeRequest(handler: (req: BlinkDecodeRequest) => Promise<ArrayBuffer>): void
}

const bridge: SelightBlinkBridge = {
  onDecodeRequest(handler) {
    ipcRenderer.on(BLINK_REQUEST_CHANNEL, (event: IpcRendererEvent, payload: unknown) => {
      // Malformed payloads are dropped: the main-side timeout normalizes the miss.
      if (!isDecodeRequest(payload)) return
      handler(payload)
        .then((jpeg) => {
          event.sender.send(BLINK_REPLY_CHANNEL, {
            requestId: payload.requestId,
            ok: true,
            jpeg
          })
        })
        .catch((err: unknown) => {
          event.sender.send(BLINK_REPLY_CHANNEL, {
            requestId: payload.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        })
    })
  }
}

contextBridge.exposeInMainWorld('selightBlink', bridge)
