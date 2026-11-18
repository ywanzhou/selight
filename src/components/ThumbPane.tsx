import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { Grid, useGridRef } from 'react-window'
import type { PhotoRow, View } from '../../electron/shared/api'
import { useAppStore } from '../state/store'
import { useSelectionContext } from '../state/selectionContext'
import { DROP_MIME } from '../state/drop'
import { anchorRowIndex, cellWidth } from '../state/gridGeometry'
import GridCell, { type ThumbCellData } from './ThumbCell'
import { ChevronLeftIcon } from './icons'

// Two columns, 10px gaps, 3:2 thumbs. The cell width is measured from the
// inner react-window Grid's clientWidth at runtime instead of deriving from
// the 200px sidebar token, so the Windows classic scrollbar can never squeeze
// the grid into horizontal overflow. FALLBACK_CELL_W matches the old fixed first paint.
const COLUMN_COUNT = 2
const GAP = 10
const FALLBACK_CELL_W = 83
const FALLBACK_GRID_W = 176

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

  const wrapRef = useRef<HTMLDivElement>(null)
  // react-window v2 imperative API via the gridRef prop (not a React ref).
  const gridRef = useGridRef(null)
  const [cellW, setCellW] = useState(FALLBACK_CELL_W)
  const hasGrid = photos.length > 0

  // Slot sizes bake in the gap; the last column/row carries no trailing gap,
  // matching the original fixed geometry at any measured width.
  const cellH = Math.round((cellW * 2) / 3)
  const rowH = cellH + GAP
  const columnWidth = (index: number): number =>
    index === COLUMN_COUNT - 1 ? cellW : cellW + GAP

  const selection = useSelectionContext()
  const { selected, anchor, nonce, toggle } = selection

  // Remount on batch/view switch: resets scroll position and prevents recycled
  // slots from briefly showing the previous view's photos at the same indices.
  const gridKey =
    view.kind === 'folder'
      ? `${batchId}:folder:${view.folderId}`
      : `${batchId}:${view.kind}`

  // Measure the react-window grid's clientWidth, not the wrap's content box:
  // the wrap never scrolls, so its width ignores the 15px classic scrollbar
  // that appears inside the grid. Observing both elements catches sidebar
  // resizes (wrap) and scrollbar appear/disappear (grid content box). Re-run
  // on gridKey so a remounted Grid gets observed, and on hasGrid for 0 -> N.
  useEffect(() => {
    const wrap = wrapRef.current
    const grid = wrap?.firstElementChild
    if (!wrap || !grid) return
    const measure = () => {
      const width = (grid as HTMLElement).clientWidth
      if (width > 0) setCellW(cellWidth(width, GAP))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(wrap)
    observer.observe(grid)
    const raf = requestAnimationFrame(measure)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [hasGrid, gridKey])

  // Keyboard follow: keep the anchored photo inside the visible grid when
  // arrow keys / number-key actions move it beyond the current scroll range.
  // gridKey resets scroll on view/batch switch, and anchor null skips work.
  const orderedIds = selection.orderedIds
  useEffect(() => {
    if (anchor === null || !hasGrid) return
    const flatIndex = orderedIds.indexOf(anchor)
    const rowIndex = anchorRowIndex(flatIndex, COLUMN_COUNT)
    if (rowIndex === null) return
    gridRef.current?.scrollToCell({ rowIndex, columnIndex: 0, rowAlign: 'smart' })
  }, [anchor, gridKey, hasGrid, orderedIds])

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
  // unselected photo first collapses the selection to just that photo. The
  // DataTransfer owns the payload, so there is no dragend state to clean up.
  const handleDragStart = useCallback(
    (id: number, e: DragEvent<HTMLDivElement>) => {
      let ids = [...selected]
      if (!selected.has(id)) {
        toggle(id)
        ids = [id]
      }
      e.dataTransfer.setData(DROP_MIME, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = 'move'
    },
    [selected, toggle]
  )

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

  // Folder view's counterpart of restore: send the selection back to inbox.
  const unassignSelection = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    try {
      await window.selight.unassign(ids)
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
    onDragStart: handleDragStart
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
          {view.kind === 'folder' && (
            // Same header placement as trash's 恢复; 0 key is the shortcut twin.
            <button
              type="button"
              className="tb-btn restore-btn"
              disabled={selected.size === 0}
              onClick={() => void unassignSelection()}
            >
              移回待分类
            </button>
          )}
          <span className="cnt">{photos.length}</span>
        </span>
      </div>

      {photos.length === 0 ? (
        <p className="pane-empty">{emptyText(view)}</p>
      ) : (
        <div
          className="thumbs-wrap"
          ref={wrapRef}
          style={{ '--thumb-w': `${cellW}px` } as CSSProperties}
        >
          <Grid<ThumbCellData>
            key={gridKey}
            gridRef={gridRef}
            cellComponent={GridCell}
            cellProps={cellProps}
            columnCount={COLUMN_COUNT}
            columnWidth={columnWidth}
            rowCount={Math.ceil(photos.length / COLUMN_COUNT)}
            rowHeight={rowH}
            onCellsRendered={handleCellsRendered}
            tabIndex={0}
            defaultWidth={FALLBACK_GRID_W}
            defaultHeight={600}
            // overflowX guard: measured widths already fit, this only absorbs
            // sub-pixel rounding so no horizontal scrollbar can ever appear.
            style={{ width: '100%', height: '100%', overflowX: 'hidden' }}
          />
        </div>
      )}
    </aside>
  )
}
