import { useEffect, useState } from 'react'
import type { ExportResult } from '../../electron/shared/api'

// v1 contract: there is no mid-copy cancel. Closing before completion (not offered in
// the UI while running) would leave the files copied so far on disk — export only ever
// adds files, never deletes, so a partial output is safe to keep or remove manually.
export interface ExportDialogProps {
  open: boolean
  outputDir: string | null
  /** Null while the export is running; set to the settled result on completion. */
  result: ExportResult | null
  onClose(): void
}

export default function ExportDialog({
  open,
  outputDir,
  result,
  onClose
}: ExportDialogProps) {
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const running = open && result === null

  useEffect(() => {
    if (open) {
      setDone(0)
      setTotal(0)
    }
  }, [open])

  // Subscribe only for the running phase; completion tears the listener down via cleanup.
  useEffect(() => {
    if (!running) return
    return window.selight.onExportProgress((event) => {
      setDone(event.done)
      setTotal(event.total)
    })
  }, [running])

  // Same modal contract as RecoveryDialog, but Esc cannot dismiss a run in progress
  // (there is no cancellation): it only closes the settled dialog.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && result !== null) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, result, onClose])

  if (!open) return null

  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  async function handleOpen(): Promise<void> {
    if (outputDir === null) return
    try {
      await window.selight.openPath(outputDir)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    // Overlay clicks never close the dialog, matching the recovery modal.
    <div className="modal-overlay">
      <div
        className="modal-card export-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
      >
        <h2 id="export-title">导出</h2>
        {result === null ? (
          <>
            <p>正在复制原文件，请稍候…</p>
            <div className="export-progress">
              <div
                className="bar export-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
              >
                <i style={{ width: `${percent}%` }} />
              </div>
              <span className="export-count">
                已复制 {done} / {total}
              </span>
            </div>
            <div className="modal-actions">
              <button type="button" className="tb-btn" disabled>
                完成
              </button>
            </div>
          </>
        ) : (
          <>
            <p>导出完成，共复制 {result.copied} 个文件。</p>
            {result.failures.length > 0 && (
              <div className="export-failures" role="alert">
                <span>{result.failures.length} 个文件导出失败：</span>
                <ul>
                  {result.failures.map((p) => (
                    <li key={p} title={p}>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="tb-btn" onClick={onClose}>
                完成
              </button>
              <button
                type="button"
                className="tb-btn tb-btn-primary"
                onClick={() => void handleOpen()}
              >
                打开输出目录
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
