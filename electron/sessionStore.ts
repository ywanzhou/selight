import fs from 'node:fs'
import path from 'node:path'
import {
  parseSession,
  serializeSession,
  type SessionState,
  type SessionStore
} from './session'

// Node-only SessionStore: debounced writes keep rapid batch/view switches off the disk,
// flush() forces the pending state during the synchronous will-quit cleanup.
export function createFileSessionStore(
  filePath: string,
  debounceMs = 250
): SessionStore {
  let pending: SessionState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  // Sibling .tmp + rename, same pattern as the media caches: a kill mid-write cannot
  // leave a truncated session.json that parseSession would have to discard.
  function writeNow(state: SessionState): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp`
    fs.writeFileSync(tmp, serializeSession(state))
    fs.renameSync(tmp, filePath)
  }

  return {
    read() {
      try {
        return parseSession(fs.readFileSync(filePath, 'utf8'))
      } catch (err) {
        // A missing file is the normal first-launch case; anything else is logged but
        // still degrades to null so boot cannot crash on a bad session file.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[selight] session read failed', err)
        }
        return null
      }
    },

    write(state) {
      pending = state
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (pending === null) return
        const next = pending
        pending = null
        try {
          writeNow(next)
        } catch (err) {
          console.error('[selight] session write failed', err)
        }
      }, debounceMs)
    },

    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (pending === null) return
      const next = pending
      pending = null
      try {
        writeNow(next)
      } catch (err) {
        console.error('[selight] session flush failed', err)
      }
    }
  }
}
