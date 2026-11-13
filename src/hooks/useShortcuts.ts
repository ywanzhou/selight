import { useEffect, useRef } from 'react'
import type { ShortcutAction } from '../state/shortcuts'
import { shortcutToAction } from '../state/shortcuts'
import { nextSelectionId } from '../state/selection'
import { useAppStore } from '../state/store'
import { useSelectionContext } from '../state/selectionContext'

type MappedAction = Exclude<ShortcutAction, null>

function isInputTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable
  )
}

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

// One window-level keydown listener for the whole app. Refs keep the handler
// closure current while the listener itself is registered once.
export function useShortcuts(): void {
  const store = useAppStore()
  const selection = useSelectionContext()
  const storeRef = useRef(store)
  storeRef.current = store
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  useEffect(() => {
    async function run(action: MappedAction): Promise<void> {
      const s = storeRef.current
      const sel = selectionRef.current
      try {
        switch (action.type) {
          case 'navigate':
            sel.navigate(action.dir)
            return
          case 'selectAll':
            sel.selectAll()
            return
          case 'backToInbox':
            // The orderedIds change recreates the selection model, which clears
            // selection as part of the same refresh.
            await s.switchView({ kind: 'inbox' })
            return
          case 'undo': {
            const { batchId } = s.state
            if (batchId === null) return
            await window.selight.undo(batchId)
            await s.refresh()
            return
          }
          case 'trash':
          case 'assign': {
            const ids = [...sel.selected]
            if (ids.length === 0) return
            const pinId = nextSelectionId(sel.orderedIds, ids, sel.anchor)
            // Arm before the awaits: after refresh recreates the model, the
            // provider's reset effect lands the selection on the pinned photo.
            sel.pinSelection(pinId)
            if (action.type === 'trash') {
              await window.selight.trash(ids)
            } else {
              const folder = s.state.folders[action.folderIndex]
              if (folder === undefined) {
                sel.pinSelection(null)
                return
              }
              await window.selight.assign(ids, folder.id)
            }
            await s.refresh()
            return
          }
        }
      } catch (e) {
        selectionRef.current.pinSelection(null)
        showError(e)
      }
    }

    function onKeyDown(e: KeyboardEvent): void {
      const action = shortcutToAction(
        e,
        storeRef.current.state.folders.length,
        isInputTarget(document.activeElement)
      )
      if (action === null) return
      // Every mapped action owns its browser default (notably Backspace/Ctrl+A),
      // so prevention is decided once here, for every non-null action.
      e.preventDefault()
      void run(action)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
