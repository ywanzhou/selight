import { useEffect, useRef, useState } from 'react'
import Toolbar from './components/Toolbar'
import ThumbPane from './components/ThumbPane'
import PreviewPane from './components/PreviewPane'
import { FolderIcon, PlusIcon } from './components/icons'
import { useShortcuts } from './hooks/useShortcuts'
import { AppStoreProvider, useAppStore } from './state/store'
import { SelectionProvider } from './state/selectionContext'

function FolderCardsPane() {
  return (
    <aside className="sidebar right frosted hairline-left">
      <div className="side-head">
        <span>文件夹</span>
      </div>
      <p className="pane-placeholder">文件夹卡片即将上线</p>
    </aside>
  )
}

function EmptyState() {
  const { createBatch } = useAppStore()
  return (
    <div className="empty-state">
      <FolderIcon size={44} className="empty-icon" />
      <h2>还没有批次</h2>
      <p>新建一个批次，然后导入照片文件夹开始分类。</p>
      <button
        type="button"
        className="tb-btn"
        onClick={() =>
          createBatch().catch((e: unknown) =>
            window.alert(e instanceof Error ? e.message : String(e))
          )
        }
      >
        <PlusIcon />
        新建批次
      </button>
    </div>
  )
}

function ErrorState() {
  const { state, boot } = useAppStore()
  return (
    <div className="empty-state" role="alert">
      <FolderIcon size={44} className="empty-icon" />
      <h2>加载失败</h2>
      <p>{state.error ?? '未知错误'}</p>
      <button type="button" className="tb-btn" onClick={() => void boot()}>
        重试
      </button>
    </div>
  )
}

function RecoveryDialog() {
  const { recoveryImport } = useAppStore()
  const [open, setOpen] = useState(false)
  const reimportButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(
    () => window.selight.onDbRecovered(() => setOpen(true)),
    []
  )

  // Focus the default action on open; Esc dismisses, same as 以后再说.
  useEffect(() => {
    if (!open) return
    reimportButtonRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!open) return null
  return (
    // Overlay clicks deliberately do not close the dialog, to prevent accidental dismiss.
    <div className="modal-overlay">
      <div
        className="modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        aria-describedby="recovery-desc"
      >
        <h2 id="recovery-title">数据库已恢复</h2>
        <p id="recovery-desc">本地数据库损坏后已重建为空库，请重新导入照片文件夹。</p>
        <div className="modal-actions">
          <button type="button" className="tb-btn" onClick={() => setOpen(false)}>
            以后再说
          </button>
          <button
            ref={reimportButtonRef}
            type="button"
            className="tb-btn tb-btn-primary"
            onClick={() => {
              setOpen(false)
              // recoveryImport creates a batch first when the rebuilt DB has none.
              recoveryImport().catch((e: unknown) =>
                window.alert(e instanceof Error ? e.message : String(e))
              )
            }}
          >
            重新导入
          </button>
        </div>
      </div>
    </div>
  )
}

// Mounted inside SelectionProvider: the global shortcut hook mutates the same
// selection model the thumbnail grid and preview read.
function Workspace() {
  useShortcuts()
  return (
    <div className="app-body">
      <ThumbPane />
      <PreviewPane />
      <FolderCardsPane />
    </div>
  )
}

function Shell() {
  const { state } = useAppStore()

  return (
    <div className="app-shell">
      <Toolbar />
      {state.error !== null ? (
        <ErrorState />
      ) : !state.loading && state.batchId === null ? (
        <EmptyState />
      ) : (
        <SelectionProvider>
          <Workspace />
        </SelectionProvider>
      )}
      <RecoveryDialog />
    </div>
  )
}

export default function App() {
  return (
    <AppStoreProvider api={window.selight}>
      <Shell />
    </AppStoreProvider>
  )
}
