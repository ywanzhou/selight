import { useState, type DragEvent } from 'react'
import type { FolderRow } from '../../electron/shared/api'
import { useAppStore } from '../state/store'
import { useSelectionContext } from '../state/selectionContext'
import { parseDropPayload } from '../state/drop'
import { FolderIcon } from './icons'
import InlineNameInput from './InlineNameInput'

interface FolderCardProps {
  folder: FolderRow
  active: boolean
  count: number
  renaming: boolean
  // Bumped to remount the inline input after a failed commit so it can be retried.
  editKey: number
  editDraft: string
  onMenu(folder: FolderRow, x: number, y: number): void
  onRenameCommit(name: string): void
  onRenameCancel(): void
}

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

export default function FolderCard({
  folder,
  active,
  count,
  renaming,
  editKey,
  editDraft,
  onMenu,
  onRenameCommit,
  onRenameCancel
}: FolderCardProps) {
  const { switchView, refresh } = useAppStore()
  const selection = useSelectionContext()
  const [dragOver, setDragOver] = useState(false)

  async function handleDrop(e: DragEvent<HTMLDivElement>): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    const ids = parseDropPayload(e.dataTransfer)
    // Empty payload (or an unparseable one) never reaches the IPC layer.
    if (ids.length === 0) return
    try {
      await window.selight.assign(ids, folder.id)
      // refresh re-pulls the current view: the photos leave inbox/another folder
      // automatically, which is the folder-to-folder re-filtering path.
      await refresh()
      selection.clear()
    } catch (err) {
      showError(err)
    }
  }

  const classes = ['fcard', active ? 'active' : '', dragOver ? 'drop' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      onClick={() => {
        if (!renaming) void switchView({ kind: 'folder', folderId: folder.id })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(folder, e.clientX, e.clientY)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        // Child-element dragleave events bubble; ignore moves that stay inside the card.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      <span className="fc-icon">
        <FolderIcon size={40} />
      </span>
      {renaming ? (
        <InlineNameInput
          key={editKey}
          initialValue={editDraft}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <span className="fc-name" title={folder.name}>
          {folder.name}
        </span>
      )}
      <span className="fc-count">{count} 张</span>
    </div>
  )
}
