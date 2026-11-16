/// <reference types="vite/client" />

import type { BlinkDecodeRequest } from '../electron/shared/blinkProtocol'

declare global {
  interface Window {
    // Exposed by electron/helper-preload.ts in the hidden helper window only.
    selightBlink?: {
      onDecodeRequest(handler: (req: BlinkDecodeRequest) => Promise<ArrayBuffer>): void
    }
  }
}
