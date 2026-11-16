import { useEffect, useState } from 'react'
import type { MediaKind } from '../../electron/shared/api'

// mediaUrl is an IPC round trip; cells and the preview mount/unmount often, so
// cache the resolved selight:// URL per photo+kind to avoid re-asking main.
const urlCache = new Map<string, string>()

export function useMediaUrl(id: number, kind: MediaKind): string | undefined {
  const key = `${kind}:${id}`
  const [url, setUrl] = useState(() => urlCache.get(key))
  useEffect(() => {
    let cancelled = false
    const cached = urlCache.get(key)
    if (cached !== undefined) {
      setUrl(cached)
      return
    }
    void window.selight.mediaUrl(id, kind).then((resolved) => {
      urlCache.set(key, resolved)
      if (!cancelled) setUrl(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [id, kind, key])
  return url
}
