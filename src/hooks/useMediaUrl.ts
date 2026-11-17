import { useEffect, useState } from 'react'
import type { MediaKind } from '../../electron/shared/api'
import { shouldReloadMedia } from '../state/mediaReady'

// Cache in module scope so the same photo+kind resolves to one base URL across
// cell remounts. The nonce query appended on media-ready events forces the img
// element to re-request after a 404-driven background generation completes.
const urlCache = new Map<string, string>()

export function useMediaUrl(id: number, kind: MediaKind): string | undefined {
  const cacheKey = `${kind}:${id}`
  const [baseUrl, setBaseUrl] = useState<string | undefined>(() =>
    urlCache.get(cacheKey)
  )
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    window.selight
      .mediaUrl(id, kind)
      .then((resolved) => {
        if (cancelled) return
        urlCache.set(cacheKey, resolved)
        setBaseUrl(resolved)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id, kind, cacheKey])

  useEffect(() => {
    const unsubscribe = window.selight.onMediaReady((event) => {
      if (shouldReloadMedia(event, id, kind)) setNonce((value) => value + 1)
    })
    return unsubscribe
  }, [id, kind])

  if (baseUrl === undefined) return undefined
  return nonce === 0 ? baseUrl : `${baseUrl}?v=${nonce}`
}
