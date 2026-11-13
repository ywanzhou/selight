import { useAppStore } from '../state/store'
import { ImportIcon, PlusIcon } from './icons'

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

export default function Toolbar() {
  const { state, openBatch, createBatch, importDirectory } = useAppStore()
  const { batches, batchId, counts, loading } = state

  const total = counts?.total ?? 0
  const classified = total - (counts?.inbox ?? 0)
  const percent = total > 0 ? (classified / total) * 100 : 0

  async function handleImport() {
    const result = await importDirectory()
    // Import failures are skipped files, not fatal: surface them instead of failing silently.
    if (result && result.failures.length > 0) {
      window.alert(`部分文件未能导入：\n${result.failures.join('\n')}`)
    }
  }

  return (
    <header className="toolbar">
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

      <button
        type="button"
        className="tb-btn"
        disabled={loading}
        onClick={() => {
          createBatch().catch(showError)
        }}
      >
        <PlusIcon />
        新建批次
      </button>

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

      <button type="button" className="tb-btn" disabled title="即将推出">
        导出
      </button>

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
