import { useEffect, useRef, useState } from 'react'
import type { FolderRow } from '../../electron/shared/api'
import { useAppStore } from '../state/store'
import FolderCard from './FolderCard'
import TrashCard from './TrashCard'
import InlineNameInput from './InlineNameInput'
import { PlusIcon } from './icons'

interface MenuState {
  folder: FolderRow
  x: number
  y: number
}

// Domain errors keep their .name across the IPC bridge; conflict gets Chinese
// copy instead of the raw English domain message.
function alertFolderError(e: unknown): void {
  if (e instanceof Error && e.name === 'FolderNameConflictError') {
    window.alert('该批次下已存在同名文件夹，请换一个名称。')
  } else {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

function FolderContextMenu({
  menu,
  onClose,
  onRename,
  onDelete
}: {
  menu: MenuState
  onClose(): void
  onRename(): void
  onDelete(): void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onPointerDown(e: PointerEvent): void {
      // Clicks on the menu itself are handled by the item buttons, not the closer.
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    function onKeyDown(e: KeyboardEvent): void {
      // Modal contract (same as RecoveryDialog): while the menu is open every
      // key belongs to the menu. Capture-phase stopPropagation runs before the
      // bubble-phase global shortcut listener, so Delete/digits/Ctrl+Z can
      // never move photos behind the menu.
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      // Clamp inside the viewport; the menu is fixed so the sidebar overflow cannot clip it.
      style={{
        left: `min(${menu.x}px, calc(100vw - 150px))`,
        top: `min(${menu.y}px, calc(100vh - 96px))`
      }}
    >
      <button type="button" role="menuitem" onClick={onRename}>
        重命名
      </button>
      <button type="button" role="menuitem" className="danger" onClick={onDelete}>
        删除文件夹
      </button>
    </div>
  )
}

export default function FolderCards() {
  const { state, refresh, switchView } = useAppStore()
  const { batchId, folders, view, counts } = state

  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editKey, setEditKey] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [folderCounts, setFolderCounts] = useState<Record<number, number>>({})

  // Per-folder photo counts have no dedicated IPC in the Task 15 contract, so
  // they are derived from the existing listView handler in one parallel fan-out.
  // shortcut: one full-row pull per folder per refresh; add a GROUP BY
  // folderCounts IPC if profiling shows this fan-out dominating refresh time.
  useEffect(() => {
    if (batchId === null || folders.length === 0) {
      setFolderCounts({})
      return
    }
    let cancelled = false
    void Promise.allSettled(
      folders.map(async (folder) => {
        const photos = await window.selight.listView(batchId, {
          kind: 'folder',
          folderId: folder.id
        })
        return [folder.id, photos.length] as const
      })
    ).then((results) => {
      if (cancelled) return
      const next: Record<number, number> = {}
      for (const result of results) {
        // A failed per-folder pull stays absent; FolderCard's ?? 0 shows 0 张
        // for that one card instead of blanking the whole grid.
        if (result.status === 'fulfilled') next[result.value[0]] = result.value[1]
      }
      setFolderCounts(next)
    })
    return () => {
      cancelled = true
    }
  }, [batchId, folders])

  function startCreate(): void {
    setMenu(null)
    setEditDraft('')
    setCreating(true)
  }

  function startRename(folder: FolderRow): void {
    setMenu(null)
    setEditDraft(folder.name)
    setRenamingId(folder.id)
  }

  async function handleCreate(name: string): Promise<void> {
    if (batchId === null) {
      setCreating(false)
      return
    }
    setEditDraft(name)
    try {
      await window.selight.createFolder(batchId, name)
      setCreating(false)
      await refresh()
    } catch (e) {
      alertFolderError(e)
      // Remount the input (key bump) with the attempted name so the user can fix it.
      setEditKey((k) => k + 1)
    }
  }

  async function handleRename(folderId: number, name: string): Promise<void> {
    setEditDraft(name)
    try {
      await window.selight.renameFolder(folderId, name)
      setRenamingId(null)
      await refresh()
    } catch (e) {
      alertFolderError(e)
      setEditKey((k) => k + 1)
    }
  }

  async function handleDelete(folder: FolderRow): Promise<void> {
    setMenu(null)
    const confirmed = window.confirm(
      `确定删除文件夹「${folder.name}」吗？其中的照片会回到待分类，不会删除原文件。`
    )
    if (!confirmed) return
    try {
      await window.selight.deleteFolder(folder.id)
      // The deleted folder's view can no longer be listed: return to inbox explicitly.
      if (view.kind === 'folder' && view.folderId === folder.id) {
        await switchView({ kind: 'inbox' })
      } else {
        await refresh()
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="sidebar right frosted hairline-left">
      <div className="side-head">
        <span>文件夹</span>
        <button
          type="button"
          className="icon-btn"
          title="新建文件夹"
          aria-label="新建文件夹"
          onClick={startCreate}
        >
          <PlusIcon />
        </button>
      </div>

      <div className="cards">
        {folders.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            active={view.kind === 'folder' && view.folderId === folder.id}
            count={folderCounts[folder.id] ?? 0}
            renaming={renamingId === folder.id}
            editKey={editKey}
            editDraft={editDraft}
            onMenu={(f, x, y) => setMenu({ folder: f, x, y })}
            onRenameCommit={(name) => void handleRename(folder.id, name)}
            onRenameCancel={() => setRenamingId(null)}
          />
        ))}

        {creating ? (
          <div className="new-card editing">
            <InlineNameInput
              key={editKey}
              initialValue={editDraft}
              placeholder="文件夹名称"
              onCommit={(name) => void handleCreate(name)}
              onCancel={() => setCreating(false)}
            />
          </div>
        ) : (
          <button type="button" className="new-card" onClick={startCreate}>
            <PlusIcon size={20} />
            <span>新建文件夹</span>
          </button>
        )}

        <TrashCard active={view.kind === 'trash'} count={counts?.trash ?? 0} />
      </div>

      {menu !== null && (
        <FolderContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={() => startRename(menu.folder)}
          onDelete={() => void handleDelete(menu.folder)}
        />
      )}
    </aside>
  )
}
