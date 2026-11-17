import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import type { Database } from 'better-sqlite3'
import { resolveMediaPath, type MediaRoots } from './resolve'

// registerSchemesAsPrivileged must run before app ready, so importing this module
// from main.ts performs the registration as a load-time side effect.
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
// can be unit-tested without Electron. URLs are selight://thumb/<id> and
// selight://photo/<id> (the host is the kind, thanks to the standard scheme).
export function registerMediaProtocol(
  db: Database,
  roots: MediaRoots,
  _rendererRoot: string
): void {
  protocol.handle('selight', async (request) => {
    try {
      const url = new URL(request.url)

      if (url.hostname !== 'thumb' && url.hostname !== 'photo') {
        return new Response('Forbidden', { status: 403 })
      }
      const file = resolveMediaPath(
        db,
        roots,
        url.hostname,
        decodeURIComponent(url.pathname.slice(1))
      )
      if (file === null) return new Response('Forbidden', { status: 403 })

      return await net.fetch(pathToFileURL(file).href)
    } catch {
      // Malformed URL or undecodable percent sequence: deny instead of crashing the handler.
      return new Response('Forbidden', { status: 403 })
    }
  })
}
