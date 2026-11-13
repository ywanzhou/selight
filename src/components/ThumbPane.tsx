import { useCallback, useRef, type DragEvent } from 'react'
import { Grid } from 'react-window'
import type { PhotoRow, View } from '../../electron/shared/api'
import { useAppStore } from '../state/store'
import { useSelectionContext } from '../state/selectionContext'
import { DROP_MIME } from '../state/drop'
import GridCell, { type ThumbCellData } from './ThumbCell'
import { ChevronLeftIcon } from './icons'

// Geometry derived from the 200px sidebar token and the mockup's .thumbs
// metrics (12px side padding, 10px gaps, 3:2 thumbs). Slot sizes bake in the
// gap; the last column/row carries no trailing gap so no horizontal overflow.
const COLUMN_COUNT = 2
const PADDING_X = 12
const GAP = 10
const CELL_W = (200 - PADDING_X * 2 - GAP) / COLUMN_COUNT // 83
const CELL_H = Math.round((CELL_W * 2) / 3) // 55
const ROW_H = CELL_H + GAP // 65

function columnWidth(index: number): number {
  return index === COLUMN_COUNT - 1 ? CELL_W : CELL_W + GAP
}

function headerTitle(view: View, folderName: string | undefined): string {
  switch (view.kind) {
    case 'inbox':
      return '待分类'
    case 'trash':
      return '回收站'
    case 'folder':
      return folderName ?? '文件夹'
  }
}

function emptyText(view: View): string {
  switch (view.kind) {
    case 'inbox':
      return '全部过完了'
    case 'folder':
      return '还没有照片，拖进来'
    case 'trash':
      return '回收站是空的'
  }
}

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

export default function ThumbPane() {
  const { state, refresh, switchView } = useAppStore()
  const { batchId, view, photos, folders } = state

  const selection = useSelectionContext()
  const { selected, anchor, nonce, toggle } = selection

  // Remount on batch/view switch: resets scroll position and prevents recycled
  // slots from briefly showing the previous view's photos at the same indices.
  const gridKey =
    view.kind === 'folder'
      ? `${batchId}:folder:${view.folderId}`
      : `${batchId}:${view.kind}`

  // Best-effort thumbnail preheat: tell the main-process queue which rendered
  // ids matter now. Dedupe identical ranges so steady scrolling stays quiet.
  const lastMarkedRef = useRef('')
  const handleCellsRendered = useCallback(
    (
      _visible: { columnStartIndex: number; columnStopIndex: number },
      allCells: {
        rowStartIndex: number;
        rowStopIndex: number;
        columnStartIndex: number;
        columnStopIndex: number;
      }
    ) => {
      const ids: number[] = []
      for (let row = allCells.rowStartIndex; row <= allCells.rowStopIndex; row++) {
        for (let col = 0; col < COLUMN_COUNT; col++) {
          const photo: PhotoRow | undefined = photos[row * COLUMN_COUNT + col]
          if (photo !== undefined) ids.push(photo.id)
        }
      }
      const key = ids.join(',')
      if (key === lastMarkedRef.current) return
      lastMarkedRef.current = key
      void window.selight.markSelection(ids).catch(() => undefined)
    },
    [photos]
  )

  // HTML5 drag source. The payload is the whole current selection; dragging an
  // unselected photo first collapses the selection to just that photo. The ref
  // is dropped on dragend so a canceled drag leaves no stale payload behind.
  const dragIdsRef = useRef<number[]>([])
  const handleDragStart = useCallback(
    (id: number, e: DragEvent<HTMLDivElement>) => {
      let ids = [...selected]
      if (!selected.has(id)) {
        toggle(id)
        ids = [id]
      }
      dragIdsRef.current = ids
      e.dataTransfer.setData(DROP_MIME, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = 'move'
    },
    [selected, toggle]
  )
  const handleDragEnd = useCallback(() => {
    dragIdsRef.current = []
  }, [])

  const restoreSelection = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    try {
      // Domain decides folder vs inbox return; refresh re-pulls the trash view.
      await window.selight.restore(ids)
      await refresh()
    } catch (e) {
      showError(e)
    }
  }, [selected, refresh])

  const folderName =
    view.kind === 'folder'
      ? folders.find((f) => f.id === view.folderId)?.name
      : undefined

  // Fresh object each render on purpose: the nonce primitive changes on every
  // mutation, which is what breaks react-window's shallow Object.is cellProps
  // memo — the selected Set itself keeps the same identity.
  const cellProps: ThumbCellData = {
    photos,
    selected,
    anchorId: anchor,
    nonce,
    onToggle: toggle,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd
  }

  return (
    <aside className="sidebar left frosted hairline-right">
      <div className="side-head">
        <span className="side-head-title">
          {view.kind === 'folder' && (
            <button
              type="button"
              className="icon-btn"
              title="返回待分类（Esc）"
              aria-label="返回待分类"
              onClick={() => void switchView({ kind: 'inbox' })}
            >
              <ChevronLeftIcon />
            </button>
          )}
          {headerTitle(view, folderName)}
        </span>
        <span className="side-head-right">
          {view.kind === 'trash' && (
            // Placement: the trash view's own header, next to the count it acts
            // on; the right-pane trash card stays a pure navigation/drop target.
            <button
              type="button"
              className="tb-btn restore-btn"
              disabled={selected.size === 0}
              onClick={() => void restoreSelection()}
            >
              恢复
            </button>
          )}
          <span className="cnt">{photos.length}</span>
        </span>
      </div>

      {photos.length === 0 ? (
        <p className="pane-empty">{emptyText(view)}</p>
      ) : (
        <div className="thumbs-wrap">
          <Grid<ThumbCellData>
            key={gridKey}
            cellComponent={GridCell}
            cellProps={cellProps}
            columnCount={COLUMN_COUNT}
            columnWidth={columnWidth}
            rowCount={Math.ceil(photos.length / COLUMN_COUNT)}
            rowHeight={ROW_H}
            onCellsRendered={handleCellsRendered}
            tabIndex={0}
            defaultWidth={200 - PADDING_X * 2}
            defaultHeight={600}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      )}
    </aside>
  )
}
