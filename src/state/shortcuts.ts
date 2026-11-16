// DOM-free keyboard mapping. The whole contract runs under bare Node in
// tests/renderer/shortcuts.test.ts; useShortcuts is the thin DOM wrapper that
// owns listener wiring, the input-focus check and preventDefault.

export type ShortcutAction =
  | { type: 'navigate'; dir: -1 | 1 }
  | { type: 'assign'; folderIndex: number }
  | { type: 'trash' }
  | { type: 'unassign' }
  | { type: 'undo' }
  | { type: 'backToInbox' }
  | { type: 'selectAll' }
  | null

export interface KeyInfo {
  key: string
  ctrlKey: boolean
  metaKey: boolean
}

export interface InputTarget {
  tagName: string
  contentEditable?: boolean
}

// DOM-free so the focus contract runs under bare Node; the hook passes
// document.activeElement's tagName/contentEditable in. SELECT is included:
// the toolbar batch dropdown retains focus after a mouse switch and owns its
// own arrow/Esc/digit/Backspace behavior.
export function isInputTarget(target: InputTarget | null): boolean {
  if (target === null) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.contentEditable === true
  )
}

export function shortcutToAction(
  e: KeyInfo,
  folderCount: number,
  inInput: boolean
): ShortcutAction {
  // Typing in an input/textarea/contenteditable never triggers global shortcuts.
  if (inInput) return null

  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return { type: 'navigate', dir: -1 }
    case 'ArrowRight':
    case 'ArrowDown':
      return { type: 'navigate', dir: 1 }
    case 'Delete':
    case 'Backspace':
      return { type: 'trash' }
    // 0 = "no folder": move the selection back to inbox. The hook ignores it
    // outside folder view, since inbox/trash photos have nothing to unassign.
    case '0':
      return { type: 'unassign' }
    case 'Escape':
      return { type: 'backToInbox' }
  }

  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase()
    if (key === 'z') return { type: 'undo' }
    if (key === 'a') return { type: 'selectAll' }
  }

  // Top-row digits 1-9 assign to the folder at index n-1; a digit past the
  // current folder count deliberately resolves to null instead of clamping.
  if (e.key.length === 1 && e.key >= '1' && e.key <= '9') {
    const folderIndex = Number(e.key) - 1
    if (folderIndex < folderCount) return { type: 'assign', folderIndex }
  }

  return null
}
