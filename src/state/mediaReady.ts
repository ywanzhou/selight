import type { MediaKind, MediaReadyEvent } from '../../electron/shared/api'

// Pure gate for useMediaUrl: only a successful ready event for the exact
// requested media triggers a nonce bump. Failed events leave the placeholder
// (its sidecar makes the cached 404→placeholder result the final state).
export function shouldReloadMedia(
  event: MediaReadyEvent,
  id: number,
  kind: MediaKind
): boolean {
  return event.ok && event.id === id && event.kind === kind
}
