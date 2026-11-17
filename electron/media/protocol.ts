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
// can be unit-tested without Electron. A thumb cache miss enqueues the id so the
// on-demand queue generates it and the renderer gets a media-ready event later.
export function registerMediaProtocol(
  db: Database,
  roots: MediaRoots,
  onThumbMissing: (id: number) => void
): void {
  protocol.handle('selight', async (request) => {
    try {
      const url = new URL(request.url)

      if (url.hostname !== 'thumb' && url.hostname !== 'photo') {
        return new Response('Forbidden', { status: 403 })
      }
      const result = resolveMediaPath(
        db,
        roots,
        url.hostname,
        decodeURIComponent(url.pathname.slice(1))
      )
      if (result.ok === false) {
        if (result.reason === 'not-generated' && url.hostname === 'thumb') {
          // MediaQueue dedupes repeated calls, so rapid grid remounts cannot
          // fan out duplicate workers for the same id.
          onThumbMissing(result.id)
        }
        return new Response('Not found', {
          status: result.reason === 'forbidden' ? 403 : 404
        })
      }

      return await net.fetch(pathToFileURL(result.file).href)
    } catch {
      // Malformed URL or undecodable percent sequence: deny instead of crashing.
      return new Response('Forbidden', { status: 403 })
    }
  })
}
