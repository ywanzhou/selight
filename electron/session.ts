import type { View } from './domain/photos'

// Persisted at userData/session.json: the last open batch and the last view in it.
// This module is pure JSON shape logic — no electron or node:fs imports — so the
// corrupt-input contract runs under bare Node in Vitest.
export interface SessionState {
  batchId: number | null
  view: View
}

// Storage seam implemented by the node-only file store in sessionStore.ts and faked
// in the handler contract tests. flush lets main force the pending write at quit.
export interface SessionStore {
  read(): SessionState | null
  write(state: SessionState): void
  flush(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseView(value: unknown): View | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  switch (value.kind) {
    case 'inbox':
      return { kind: 'inbox' }
    case 'trash':
      return { kind: 'trash' }
    case 'folder':
      // Number.isInteger rejects strings, booleans and floats without coercing them.
      return Number.isInteger(value.folderId)
        ? { kind: 'folder', folderId: value.folderId as number }
        : null
    default:
      return null
  }
}

// Corrupt JSON, non-objects and wrong shapes all return null; this must never throw,
// because a garbage session.json has to leave the normal most-recent-batch boot intact.
export function parseSession(text: string): SessionState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const { batchId, view } = parsed
  if (batchId !== null && !Number.isInteger(batchId)) return null
  const parsedView = parseView(view)
  if (parsedView === null) return null
  return { batchId: batchId as number | null, view: parsedView }
}

export function serializeSession(state: SessionState): string {
  return JSON.stringify(state)
}
