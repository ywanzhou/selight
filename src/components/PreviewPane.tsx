import { useCallback, useEffect, useState, type DragEvent } from 'react'
import type { PhotoRow } from '../../electron/shared/api'
import { useMediaUrl } from '../hooks/useMediaUrl'
import { useAppStore } from '../state/store'
import { useSelectionContext } from '../state/selectionContext'
import { DROP_MIME, dragPhotoIds } from '../state/drop'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

function formatSize(sizeBytes: number): string {
  return `${(sizeBytes / 1048576).toFixed(1)} MB`
}

// Always invokes the media hook (rules of hooks); the missing flag or a failed
// load replaces the image with an unavailability message instead of breaking it.
function StageImage({ photo }: { photo: PhotoRow }) {
  const src = useMediaUrl(photo.id, 'photo')
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [photo.id])

  if (photo.missing === 1 || failed) {
    return (
      <p className="stage-msg" role="status">
        原文件缺失，暂时无法预览
      </p>
    )
  }
  if (src === undefined) return null
  return (
    // key=src mirrors ThumbCell: a new photo in this slot remounts the img so
    // an inline error state from the previous one cannot stick.
    <img
      key={src}
      src={src}
      alt={photo.filename}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

function MetaBar({ photo }: { photo: PhotoRow }) {
  const parts = [photo.filename]
  if (photo.width !== null && photo.height !== null) {
    parts.push(`${photo.width} × ${photo.height}`)
  }
  parts.push(formatSize(photo.sizeBytes))

  return (
    <div className="preview-meta">
      <span className="meta-info" title={photo.filename}>
        {parts.join(' · ')}
      </span>
      <span className="meta-hints">
        <kbd>←</kbd> <kbd>→</kbd> 切换&nbsp;&nbsp;·&nbsp;&nbsp;<kbd>1</kbd>–
        <kbd>9</kbd> 分配&nbsp;&nbsp;·&nbsp;&nbsp;<kbd>Delete</kbd> 删除&nbsp;&nbsp;·&nbsp;&nbsp;
        <kbd>Esc</kbd> 返回
      </span>
    </div>
  )
}

export default function PreviewPane() {
  const { state } = useAppStore()
  const { photos } = state
  const { anchor, orderedIds, navigate, selected, toggle } = useSelectionContext()
  const photo = anchor === null ? undefined : photos.find((p) => p.id === anchor)
  const anchorIndex = anchor === null ? -1 : orderedIds.indexOf(anchor)

  // Same drag contract as the thumbnail grid: the payload is the whole
  // selection, or just the previewed photo when it is not part of it.
  const handleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (anchor === null) return
      const ids = dragPhotoIds([...selected], anchor)
      if (!selected.has(anchor)) toggle(anchor)
      e.dataTransfer.setData(DROP_MIME, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = 'move'
    },
    [anchor, selected, toggle]
  )

  return (
    <main className="preview-pane">
      {photo === undefined ? (
        <p className="pane-empty" role="status">
          选择一张照片开始预览
        </p>
      ) : (
        <>
          <div className="preview-stage" draggable onDragStart={handleDragStart}>
            <StageImage photo={photo} />
            <button
              type="button"
              className="nav-circle l"
              aria-label="上一张"
              disabled={anchorIndex <= 0}
              onClick={() => navigate(-1)}
            >
              <ChevronLeftIcon />
            </button>
            <button
              type="button"
              className="nav-circle r"
              aria-label="下一张"
              disabled={anchorIndex === -1 || anchorIndex >= orderedIds.length - 1}
              onClick={() => navigate(1)}
            >
              <ChevronRightIcon />
            </button>
          </div>
          <MetaBar photo={photo} />
        </>
      )}
    </main>
  )
}
