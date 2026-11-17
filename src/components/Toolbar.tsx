import { useState } from 'react'
import { useAppStore } from '../state/store'
import { ExportIcon, ImportIcon, PencilIcon, TrashIcon } from './icons'
import CreateBatchButton from './CreateBatchButton'
import InlineNameInput from './InlineNameInput'

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
  const { batches, batchId, counts, loading, enrichProgress } = state
  const [renaming, setRenaming] = useState(false)
  const [importing, setImporting] = useState(false)
  const currentName = batches.find((b) => b.id === batchId)?.name ?? ''

  async function handleCleanupCache() {
    const { removed } = await cleanupMediaCache()
    if (removed > 0) window.alert(`已清理 ${removed} 个缓存文件`)
  }

  const total = counts?.total ?? 0
  const classified = total - (counts?.inbox ?? 0)
  const percent = total > 0 ? (classified / total) * 100 : 0
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
        <select
          className="tb-select"
          value={batchId ?? ''}
          disabled={batches.length === 0 || loading}
          onChange={(e) => {
            openBatch(Number(e.target.value)).catch(showError)
          }}
          aria-label="选择批次"
        >
          {batches.length === 0 && <option value="">无批次</option>}
          {batches.map((batch) => (
            <option key={batch.id} value={batch.id}>
              {batch.name}
            </option>
          ))}
        </select>
      )}

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
        className="icon-btn"
        title="删除当前批次"
        aria-label="删除当前批次"
        disabled={batchId === null || loading}
        onClick={() => {
          handleDeleteBatch().catch(showError)
        }}
      >
        <TrashIcon />
      </button>

      <CreateBatchButton />

      {/* Text button rather than a second TrashIcon: cache cleanup is safe and
          reversible, unlike the adjacent destructive batch-delete action. */}
      <button
        type="button"
        className="tb-btn"
        title="清理失效的缩略图与预览缓存"
        disabled={loading}
        onClick={() => {
          handleCleanupCache().catch(showError)
        }}
      >
        清缓存
      </button>

      {importing ? (
        <button
          type="button"
          className="tb-btn"
          onClick={() => {
            handleCancelImport().catch(showError)
          }}
        >
          取消导入
        </button>
      ) : (
        <button
          type="button"
          className="tb-btn"
          disabled={batchId === null || loading}
          onClick={() => {
            handleImport().catch(showError)
          }}
        >
          <ImportIcon />
          导入文件夹
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
          className="tb-btn"
          disabled={batchId === null || loading || nothingToExport}
          onClick={onExport}
        >
          <ExportIcon />
          导出
        </button>
      </span>

      {enrichProgress !== null && (
        <span className="tb-enrich" role="status">
          正在处理 {enrichProgress.done}/{enrichProgress.total}
        </span>
      )}

      <div className="tb-progress">
        <span>
          已分 {classified} / 共 {total}
        </span>
        <div
          className="bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={classified}
        >
          <i style={{ width: `${percent}%` }} />
        </div>
      </div>
    </header>
  )
}
