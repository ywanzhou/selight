// Electron-free contract of the hidden Blink thumbnail helper. The IPC message
// shapes, validators, whitelist filter, timeout race and error normalization all
// live here so the trust-boundary logic runs under bare-node Vitest; the Electron
// window/IPC shell lives in electron/media/blinkThumbnail.ts.

export const BLINK_REQUEST_CHANNEL = 'selight:blink:decode-request'
export const BLINK_REPLY_CHANNEL = 'selight:blink:decode-reply'

// Ruling 18: width 320 JPEGs, 10s per-request timeout, at most two decodes in flight.
export const BLINK_THUMB_WIDTH = 320
export const BLINK_JPEG_QUALITY = 0.85
export const BLINK_TIMEOUT_MS = 10_000
export const BLINK_MAX_CONCURRENCY = 2

export type BlinkErrorCode =
  | 'BLINK_NOT_CONFIGURED'
  | 'BLINK_NOT_WHITELISTED'
  | 'BLINK_NO_HELPER'
  | 'BLINK_TIMEOUT'
  | 'BLINK_BAD_REPLY'
  | 'BLINK_DECODE'

export class BlinkThumbnailError extends Error {
  readonly code: BlinkErrorCode
  constructor(
    code: BlinkErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'BlinkThumbnailError'
    this.code = code
  }
}

// Main → helper: decode the registered photo whose id/absPath were DB-validated.
export interface BlinkDecodeRequest {
  requestId: number
  photoId: number
  absPath: string
}

// Helper → main: either a JPEG ArrayBuffer or a non-empty error string.
export interface BlinkDecodeReply {
  requestId: number
  ok: boolean
  jpeg?: ArrayBuffer
  error?: string
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isDecodeRequest(value: unknown): value is BlinkDecodeRequest {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    isPositiveInt(r.requestId) &&
    isPositiveInt(r.photoId) &&
    typeof r.absPath === 'string' &&
    r.absPath.length > 0
  )
}

export function isDecodeReply(value: unknown): value is BlinkDecodeReply {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  if (!isPositiveInt(r.requestId) || typeof r.ok !== 'boolean') return false
  if (r.ok) {
    return r.jpeg instanceof ArrayBuffer && r.jpeg.byteLength > 0
  }
  return typeof r.error === 'string' && r.error.length > 0
}

// Per-route CORS header policy. Only the photo route is fetched cross-origin (by the
// Blink helper); thumb is consumed only through same-origin media URLs and must never
// carry a wildcard header, or an XSS-compromised renderer could enumerate ids and
// exfiltrate full-resolution sources with fetch directly.
export function corsHeadersFor(hostname: string): Record<string, string> {
  return hostname === 'photo' ? { 'Access-Control-Allow-Origin': '*' } : {}
}

// Whitelist gate used by pure tests with an explicit allowed set; the production
// client injects a live DB lookup in place of the materialized set.
export function isAllowedAbsPath(
  absPath: unknown,
  allowed: ReadonlySet<string>
): absPath is string {
  return typeof absPath === 'string' && absPath.length > 0 && allowed.has(absPath)
}

export function normalizeBlinkError(
  code: BlinkErrorCode,
  message: string,
  cause?: unknown
): BlinkThumbnailError {
  return new BlinkThumbnailError(
    code,
    `[selight] blink thumbnail: ${message}`,
    cause === undefined ? undefined : { cause }
  )
}

// Races a task against a timeout. On timeout the task promise is left pending and
// the client drops its late reply via request-id correlation.
export function withTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        normalizeBlinkError('BLINK_TIMEOUT', `${label} timed out after ${timeoutMs}ms`)
      )
    }, timeoutMs)
    task().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause)
      }
    )
  })
}
