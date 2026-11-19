import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import type { PhotoRow } from '../../electron/shared/api'
import { useMediaUrl } from '../hooks/useMediaUrl'
import { useAppStore } from '../state/store'
import { useSelectionContext } from '../state/selectionContext'
import { DROP_MIME, dragPhotoIds } from '../state/drop'
import { derivePreviewState } from '../state/previewState'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

function formatSize(sizeBytes: number): string {
  return `${(sizeBytes / 1048576).toFixed(1)} MB`
}

// Always invokes the media hook (rules of hooks); the missing flag or a failed
// load replaces the image with an explicit state instead of breaking the hook.
//
// Two reset mechanisms, deliberately split:
// - Cross-photo navigation remounts this component via the parent's
//   key={photo.id}, so loaded/loadFailed start false with no effect involved.
// - Within one photo, the first request can 404 before the on-demand preview is
//   built; once it is, useMediaUrl bumps a nonce and src gains "?v=". That
//   in-instance src change must clear loadFailed so the img retries and leaves
//   the failed state. The effect skips its first run (mount): resetting there
//   would overwrite a cache-hit onLoad that fired before the passive effect,
//   pinning a cached preview on the loading spinner forever (see ERROR.md).
function StageImage({ photo }: { photo: PhotoRow }) {
  const src = useMediaUrl(photo.id, 'photo')
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const firstEffect = useRef(true)

  useEffect(() => {
    if (firstEffect.current) {
      firstEffect.current = false
      return
    }
    // Nonce-driven reload of the same photo after background generation.
    setLoaded(false)
    setLoadFailed(false)
  }, [src])

  const state = derivePreviewState({
    missing: photo.missing === 1,
    loadFailed,
    loaded
  })

  async function handleRetry(): Promise<void> {
    setLoadFailed(false)
    try {
      await window.selight.retryMedia(photo.id, 'photo')
    } catch {
      setLoadFailed(true)
    }
  }

  if (state === 'missing') {
    return (
      <p className="stage-msg" role="status">
        原文件缺失，暂时无法预览
      </p>
    )
  }
  if (state === 'failed') {
    return (
      <div className="preview-failed" role="alert">
        <p>预览生成失败</p>
        <button type="button" className="tb-btn" onClick={() => void handleRetry()}>
          重试
        </button>
      </div>
    )
  }

  return (
    <>
      {state === 'loading' && <div className="preview-loading" aria-hidden="true" />}
      {src && (
        // key=src mirrors ThumbCell: a nonce bump remounts the img so the
        // request for the regenerated preview actually fires.
        <img
          key={src}
          src={src}
          alt={photo.filename}
          draggable={false}
          style={{ visibility: state === 'ready' ? 'visible' : 'hidden' }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoadFailed(true)}
        />
      )}
    </>
  )
}

function MetaBar({ photo }: { photo: PhotoRow }) {
  const parts: string[] = [photo.filename]
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
        <kbd>9</kbd> 分配&nbsp;&nbsp;·&nbsp;&nbsp;<kbd>0</kbd> 移回待分类&nbsp;&nbsp;·&nbsp;&nbsp;
        <kbd>Delete</kbd> 删除&nbsp;&nbsp;·&nbsp;&nbsp;<kbd>Esc</kbd> 返回
      </span>
    </div>
  )
}

export default function PreviewPane() {
  const { state } = useAppStore()
  const { photos } = state
  const { anchor, orderedIds, navigate, selected, toggle } = useSelectionContext()
  const anchorIndex = anchor === null ? -1 : orderedIds.indexOf(anchor)
  const photo = anchor === null ? undefined : photos.find((p) => p.id === anchor)

  const handleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (anchor === null) return
      e.dataTransfer.setData(DROP_MIME, JSON.stringify(dragPhotoIds([...selected], anchor)))
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
            <StageImage key={photo.id} photo={photo} />
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
