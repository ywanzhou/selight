import { useCallback, useMemo, useRef, type KeyboardEvent } from 'react'
import { Grid } from 'react-window'
import type { PhotoRow, View } from '../../electron/shared/api'
import { useAppStore } from '../state/store'
import { useSelection } from '../hooks/useSelection'
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

export default function ThumbPane() {
  const { state, setSelection } = useAppStore()
  const { batchId, view, photos, folders } = state

  const orderedIds = useMemo(() => photos.map((p) => p.id), [photos])
  const selection = useSelection(orderedIds, setSelection)
  const { selected, anchor, nonce, toggle, selectAll } = selection

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
        rowStartIndex: number
        rowStopIndex: number
        columnStartIndex: number
        columnStopIndex: number
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

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        selectAll()
      }
    },
    [selectAll]
  )

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
    onToggle: toggle
  }

  return (
    <aside className="sidebar left frosted hairline-right">
      <div className="side-head">
        <span className="side-head-title">
          {view.kind === 'folder' && (
            // Slot for Task 15's back-to-inbox navigation.
            <button type="button" className="icon-btn" disabled title="返回（即将推出）">
              <ChevronLeftIcon />
            </button>
          )}
          {headerTitle(view, folderName)}
        </span>
        <span className="cnt">{photos.length}</span>
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
            onKeyDown={handleKeyDown}
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
