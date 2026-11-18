import { useEffect } from 'react'
import type { ManifestResult } from '../../electron/shared/api'

// v2 contract: export produces one manifest JSON file, written in a single
// tmp-then-rename step, so there is no progress stream — the dialog only has
// a brief writing state and the settled counts. Closing while writing is not
// offered; the write is local and fast.
export interface ExportDialogProps {
  open: boolean
  targetPath: string | null
  targetDir: string | null
  /** Null while the write is running; set to the settled result on completion. */
  result: ManifestResult | null
  onClose(): void
}

export default function ExportDialog({
  open,
  targetPath,
  targetDir,
  result,
  onClose
}: ExportDialogProps) {
  // Same modal contract as RecoveryDialog, but Esc cannot dismiss a run in
  // progress: it only closes the settled dialog.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && result !== null) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, result, onClose])

  if (!open) return null

  async function handleOpen(): Promise<void> {
    if (targetDir === null) return
    try {
      await window.selight.openPath(targetDir)
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
        <h2 id="export-title">导出分类清单</h2>
        {result === null ? (
          <>
            <p>正在写入清单，请稍候…</p>
            <div className="preview-loading" aria-hidden="true" />
            <div className="modal-actions">
              <button type="button" className="tb-btn" disabled>
                完成
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              已导出清单：{result.folderCount} 个文件夹、{result.photoCount} 张照片。
            </p>
            {targetPath !== null && (
              <p className="export-target" title={targetPath}>
                {targetPath}
              </p>
            )}
            {result.missingCount > 0 && (
              <p className="export-missing" role="alert">
                其中 {result.missingCount} 张源文件已丢失，取片时会跳过。
              </p>
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
                打开所在目录
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
