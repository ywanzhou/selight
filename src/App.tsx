import { useEffect, useRef, useState } from 'react'
import Toolbar from './components/Toolbar'
import ThumbPane from './components/ThumbPane'
import PreviewPane from './components/PreviewPane'
import FolderCards from './components/FolderCards'
import ExportDialog from './components/ExportDialog'
import CreateBatchButton from './components/CreateBatchButton'
import { FolderIcon } from './components/icons'
import { useShortcuts } from './hooks/useShortcuts'
import { AppStoreProvider, useAppStore } from './state/store'
import { SelectionProvider } from './state/selectionContext'
import type { ExportResult } from '../electron/shared/api'

// Null = dialog closed; result === null within the object means the copy is still running.
interface ExportRun {
  outputDir: string
  result: ExportResult | null
}

function EmptyState() {
  return (
    <div className="empty-state">
      <FolderIcon size={44} className="empty-icon" />
      <h2>还没有批次</h2>
      <p>新建一个批次，然后导入照片文件夹开始分类。</p>
      <CreateBatchButton />
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

function RecoveryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { recoveryImport } = useAppStore()
  const reimportButtonRef = useRef<HTMLButtonElement>(null)

  // Focus the default action on open; Esc dismisses, same as 以后再说. The
  // global shortcut hook is disabled while this modal is open.
  useEffect(() => {
    if (!open) return
    reimportButtonRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

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
          <button type="button" className="tb-btn" onClick={onClose}>
            以后再说
          </button>
          <button
            ref={reimportButtonRef}
            type="button"
            className="tb-btn tb-btn-primary"
            onClick={() => {
              onClose()
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
// selection model the thumbnail grid and preview read. While the recovery modal
// is open the hook is disabled so keys cannot act on the grid behind it.
function Workspace({ modalOpen }: { modalOpen: boolean }) {
  useShortcuts(modalOpen)
  return (
    <div className="app-body">
      <ThumbPane />
      <PreviewPane />
      <FolderCards />
    </div>
  )
}

function Shell() {
  const { state, exportBatch } = useAppStore()
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [exportRun, setExportRun] = useState<ExportRun | null>(null)

  useEffect(
    () => window.selight.onDbRecovered(() => setRecoveryOpen(true)),
    []
  )

  async function handleExport(): Promise<void> {
    if (exportRun !== null) return
    const outputDir = await window.selight.pickExportDirectory()
    if (!outputDir) return
    setExportRun({ outputDir, result: null })
    try {
      const result = await exportBatch(outputDir)
      // A batch switch mid-run resolves to null: just close instead of sticking the dialog.
      setExportRun(result === null ? null : { outputDir, result })
    } catch (e) {
      setExportRun(null)
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="app-shell">
      <Toolbar onExport={() => void handleExport()} />
      {state.error !== null ? (
        <ErrorState />
      ) : !state.loading && state.batchId === null ? (
        <EmptyState />
      ) : (
        <SelectionProvider>
          <Workspace modalOpen={recoveryOpen || exportRun !== null} />
        </SelectionProvider>
      )}
      <RecoveryDialog open={recoveryOpen} onClose={() => setRecoveryOpen(false)} />
      <ExportDialog
        open={exportRun !== null}
        outputDir={exportRun?.outputDir ?? null}
        result={exportRun?.result ?? null}
        onClose={() => setExportRun(null)}
      />
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
