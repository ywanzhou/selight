import { useState } from 'react'
import { useAppStore } from '../state/store'
import {
  BroomIcon,
  ExportIcon,
  ImportIcon,
  PencilIcon,
  TrashIcon,
  XmarkIcon
} from './icons'
import CreateBatchButton from './CreateBatchButton'
import InlineNameInput from './InlineNameInput'
import BatchPicker from './BatchPicker'

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

export default function Toolbar({ onExport }: { onExport: () => void }) {
  const {
    state,
    openBatch,
    importDirectory,
    cancelImport,
    deleteBatch,
    renameBatch,
    cleanupMediaCache
  } = useAppStore()
  const { batches, batchId, counts, loading } = state
  const [renaming, setRenaming] = useState(false)
  const [importing, setImporting] = useState(false)
  const currentName = batches.find((b) => b.id === batchId)?.name ?? ''

  async function handleCleanupCache() {
    const { removed } = await cleanupMediaCache()
    if (removed > 0) window.alert(`已清理 ${removed} 个缓存文件`)
  }

  const total = counts?.total ?? 0
  // Export only copies status='folder' photos; zero of them means an empty output.
  const nothingToExport = (counts?.folder ?? 0) === 0

  async function handleDeleteBatch(): Promise<void> {
    if (batchId === null) return
    const name = batches.find((b) => b.id === batchId)?.name ?? ''
    const confirmed = window.confirm(
      `确定删除批次「${name}」吗？\n该批次的 ${total} 张照片记录、文件夹与分类都会删除，磁盘上的原文件不会被删除，此操作不可撤销。`
    )
    if (!confirmed) return
    await deleteBatch(batchId)
  }

  async function handleImport() {
    // Discovery is fast but still async: block double clicks, which would
    // submit overlapping scans against the same source.
    setImporting(true)
    try {
      const result = await importDirectory()
      // Import failures are skipped files, not fatal: surface them instead of failing silently.
      if (result && result.failures.length > 0) {
        window.alert(`部分文件未能导入：\n${result.failures.join('\n')}`)
      }
    } finally {
      setImporting(false)
    }
  }

  async function handleCancelImport() {
    await cancelImport()
    setImporting(false)
  }

  return (
    <header className="toolbar">
      {renaming && batchId !== null ? (
        <span className="batch-name-input">
          <InlineNameInput
            initialValue={currentName}
            onCommit={(name) => {
              setRenaming(false)
              if (name === currentName) return
              renameBatch(batchId, name).catch(showError)
            }}
            onCancel={() => setRenaming(false)}
          />
        </span>
      ) : (
        <BatchPicker
          batches={batches}
          batchId={batchId}
          loading={loading}
          onOpen={(id) => {
            openBatch(id).catch(showError)
          }}
        />
      )}

      <span className="tb-divider" aria-hidden="true" />

      <button
        type="button"
        className="icon-btn"
        title="重命名当前批次"
        aria-label="重命名当前批次"
        disabled={batchId === null || loading}
        onClick={() => setRenaming(true)}
      >
        <PencilIcon />
      </button>

      <button
        type="button"
        className="icon-btn danger"
        title="删除当前批次"
        aria-label="删除当前批次"
        disabled={batchId === null || loading}
        onClick={() => {
          handleDeleteBatch().catch(showError)
        }}
      >
        <TrashIcon />
      </button>

      <CreateBatchButton icon />

      <span className="tb-divider" aria-hidden="true" />

      {/* Broom rather than a second trash icon: cache cleanup is safe and
          reversible, unlike the adjacent destructive batch-delete action. */}
      <button
        type="button"
        className="icon-btn"
        title="清理失效的缩略图与预览缓存"
        aria-label="清理失效的缩略图与预览缓存"
        disabled={loading}
        onClick={() => {
          handleCleanupCache().catch(showError)
        }}
      >
        <BroomIcon />
      </button>

      <span className="tb-divider" aria-hidden="true" />

      {importing ? (
        <button
          type="button"
          className="icon-btn accent"
          title="取消导入"
          aria-label="取消导入"
          onClick={() => {
            handleCancelImport().catch(showError)
          }}
        >
          <XmarkIcon />
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn"
          title="导入文件夹"
          aria-label="导入文件夹"
          disabled={batchId === null || loading}
          onClick={() => {
            handleImport().catch(showError)
          }}
        >
          <ImportIcon />
        </button>
      )}

      {/* Wrapper span carries the tooltip: a disabled button itself never fires
          mouse events, so its own title would never appear. */}
      <span
        className="tb-btn-wrap"
        title={nothingToExport ? '还没有分配到文件夹的照片，暂无可导出内容' : undefined}
      >
        <button
          type="button"
          className="icon-btn"
          title="导出"
          aria-label="导出"
          disabled={batchId === null || loading || nothingToExport}
          onClick={onExport}
        >
          <ExportIcon />
        </button>
      </span>
    </header>
  )
}
