// Response builders for the selight:// media protocol. Kept Electron-free so
// the header policy is unit-testable under bare Node — protocol.ts imports
// Electron at module load and cannot be imported from Vitest.
//
// Every response carries Cache-Control: no-store, including 404s. A cached
// negative response would bypass the handler after the on-demand queue fills
// the cache, while the renderer's nonce reload only fires on a fresh
// media-ready event; a stale 404 therefore hangs the preview on an endless
// loading state. Revalidating per request costs nothing for local file reads.
export const NO_STORE = 'no-store'

export function mediaErrorResponse(status: 403 | 404): Response {
  return new Response(status === 404 ? 'Not found' : 'Forbidden', {
    status,
    headers: { 'Cache-Control': NO_STORE }
  })
}

// Re-wrap a successful net.fetch Response so the no-store header can be set;
// the body stream, status and existing headers (e.g. Content-Type) survive.
export function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', NO_STORE)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}
