import { useEffect, useState } from 'react'
import Toolbar from './components/Toolbar'
import { FolderIcon, PlusIcon } from './components/icons'
import { AppStoreProvider, useAppStore } from './state/store'

// Placeholder panes: real ThumbPane/PreviewPane/FolderCards land in Tasks 13-15.
// The shell geometry, frosted sidebars and hairline dividers are already final.
function ThumbPane() {
  return (
    <aside className="sidebar left frosted hairline-right">
      <div className="side-head">
        <span>待分类</span>
      </div>
      <p className="pane-placeholder">缩略图即将上线</p>
    </aside>
  )
}

function PreviewPane() {
  return (
    <main className="preview-pane">
      <p className="pane-placeholder">预览即将上线</p>
    </main>
  )
}

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
      <button type="button" className="tb-btn" onClick={() => void createBatch()}>
        <PlusIcon />
        新建批次
      </button>
    </div>
  )
}

function RecoveryDialog() {
  const { importDirectory } = useAppStore()
  const [open, setOpen] = useState(false)

  useEffect(
    () => window.selight.onDbRecovered(() => setOpen(true)),
    []
  )

  if (!open) return null
  return (
    <div className="modal-overlay" role="alertdialog" aria-modal="true">
      <div className="modal-card">
        <h2>数据库已恢复</h2>
        <p>本地数据库损坏后已重建为空库，请重新导入照片文件夹。</p>
        <div className="modal-actions">
          <button type="button" className="tb-btn" onClick={() => setOpen(false)}>
            以后再说
          </button>
          <button
            type="button"
            className="tb-btn tb-btn-primary"
            onClick={async () => {
              setOpen(false)
              await importDirectory()
            }}
          >
            重新导入
          </button>
        </div>
      </div>
    </div>
  )
}

function Shell() {
  const { state } = useAppStore()
  const showEmpty = !state.loading && state.batchId === null

  return (
    <div className="app-shell">
      <Toolbar />
      {showEmpty ? (
        <EmptyState />
      ) : (
        <div className="app-body">
          <ThumbPane />
          <PreviewPane />
          <FolderCardsPane />
        </div>
      )}
      <RecoveryDialog />
    </div>
  )
}

export default function App() {
  return (
    <AppStoreProvider>
      <Shell />
    </AppStoreProvider>
  )
}
