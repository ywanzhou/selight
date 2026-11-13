// DOM-free HTML5 drag payload contract. Thumb cells write the dragged photo ids
// under this mime at dragstart; folder/trash cards parse them at drop. The parse
// logic lives here (not in the components) so it runs under bare Node in Vitest.

export const DROP_MIME = 'application/x-zeying-photos'

interface DataTransferLike {
  getData?: (mime: string) => string
}

/**
 * Read and validate a dropped photo-id list. Never throws: a missing mime,
 * malformed JSON, a non-array body or non-number elements all degrade to [] so
 * the call site can simply skip the IPC when nothing usable was dropped.
 * Number ids are deduped in first-seen order.
 */
export function parseDropPayload(
  dataTransferLike: DataTransferLike | null | undefined
): number[] {
  const getData = dataTransferLike?.getData
  if (typeof getData !== 'function') return []

  const raw = getData.call(dataTransferLike, DROP_MIME)
  if (!raw) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const seen = new Set<number>()
  const ids: number[] = []
  for (const item of parsed) {
    if (typeof item === 'number' && !seen.has(item)) {
      seen.add(item)
      ids.push(item)
    }
  }
  return ids
}
