import { useState, type DragEvent } from 'react'
import { useAppStore } from '../state/store'
import { useSelectionContext } from '../state/selectionContext'
import { nextSelectionId } from '../state/selection'
import { parseDropPayload } from '../state/drop'
import { TrashIcon } from './icons'

interface TrashCardProps {
  active: boolean
  count: number
}

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

// Red-toned horizontal strip pinned below the scrolling folder grid. Same drop
// contract as FolderCard but routes the payload to trash() instead of assign().
export default function TrashCard({ active, count }: TrashCardProps) {
  const { switchView, refresh } = useAppStore()
  const selection = useSelectionContext()
  const [dragOver, setDragOver] = useState(false)

  async function handleDrop(e: DragEvent<HTMLDivElement>): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    const ids = parseDropPayload(e.dataTransfer)
    if (ids.length === 0) return
    // Pin before the awaits, same as the Delete shortcut: after refresh the
    // preview lands on the next remaining photo instead of going empty.
    selection.pinSelection(nextSelectionId(selection.orderedIds, ids, selection.anchor))
    try {
      await window.selight.trash(ids)
      await refresh()
    } catch (err) {
      selection.pinSelection(null)
      showError(err)
    }
  }

  const classes = ['fcard', 'trash', active ? 'active' : '', dragOver ? 'drop' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      onClick={() => void switchView({ kind: 'trash' })}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      <span className="fc-icon">
        <TrashIcon size={36} />
      </span>
      <span className="fc-name">回收站</span>
      <span className="fc-count">{count} 张 · 不删原文件</span>
    </div>
  )
}
