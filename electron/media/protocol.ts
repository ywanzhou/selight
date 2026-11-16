import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Database } from 'better-sqlite3'
import { isInside, resolveMediaPath, type MediaRoots } from './resolve'
import { corsHeadersFor } from '../shared/blinkProtocol'

// registerSchemesAsPrivileged must run before app ready, so importing this module
// from main.ts performs the registration as a load-time side effect. corsEnabled lets
// the helper page served from selight://helper fetch selight://photo cross-origin:
// Chromium refuses CORS entirely from file:// origins.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'selight',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

// Thin Electron shell: all authorization lives in the pure resolveMediaPath so it
// can be unit-tested without Electron. URLs are selight://thumb/<id>,
// selight://photo/<id> and selight://helper/<built-asset> (the host is the kind,
// thanks to the standard scheme).
export function registerMediaProtocol(
  db: Database,
  roots: MediaRoots,
  rendererRoot: string
): void {
  const builtRoot = path.resolve(rendererRoot)
  protocol.handle('selight', async (request) => {
    try {
      const url = new URL(request.url)

      let file: string | null
      if (url.hostname === 'helper') {
        // Fixed set of trusted build outputs only: the candidate must stay inside
        // rendererRoot; no caller-supplied path ever escapes that directory.
        const candidate = path.resolve(
          builtRoot,
          decodeURIComponent(url.pathname.slice(1))
        )
        file = isInside(builtRoot, candidate) ? candidate : null
      } else if (url.hostname === 'thumb' || url.hostname === 'photo') {
        file = resolveMediaPath(
          db,
          roots,
          url.hostname,
          decodeURIComponent(url.pathname.slice(1))
        )
      } else {
        return new Response('Forbidden', { status: 403 })
      }
      if (file === null) return new Response('Forbidden', { status: 403 })

      const served = await net.fetch(pathToFileURL(file).href)
      // ACAO is photo-route-only (pure policy in corsHeadersFor): the helper page and
      // photo route are different selight hosts, while thumb responses stay header-free
      // so a compromised renderer cannot fetch-enumerate them cross-origin.
      const headers = new Headers(served.headers)
      for (const [name, value] of Object.entries(corsHeadersFor(url.hostname))) {
        headers.set(name, value)
      }
      return new Response(served.body, { status: served.status, headers })
    } catch {
      // Malformed URL or undecodable percent sequence: deny instead of crashing the handler.
      return new Response('Forbidden', { status: 403 })
    }
  })
}
