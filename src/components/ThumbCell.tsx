import { type CSSProperties, type DragEvent } from 'react'
import type { PhotoRow } from '../../electron/shared/api'
import { useMediaUrl } from '../hooks/useMediaUrl'
import type { ToggleOptions } from '../state/selection'
import { CheckIcon, WarningIcon } from './icons'

export interface ThumbCellData {
  photos: PhotoRow[]
  selected: Set<number>
  anchorId: number | null
  // Bumped on every selection mutation; breaks react-window's shallow cellProps
  // memo even though the selected Set mutates in place.
  nonce: number
  onToggle: (id: number, options: ToggleOptions) => void
  // HTML5 drag source: dragstart writes the current selection (or just the
  // dragged photo) under the shared drop mime.
  onDragStart: (id: number, e: DragEvent<HTMLDivElement>) => void
}

interface GridCellProps extends ThumbCellData {
  rowIndex: number
  columnIndex: number
  style: CSSProperties
  ariaAttributes: { role: string; 'aria-colindex': number }
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function ThumbCell({ photo, isAnchor, isSelected }: {
  photo: PhotoRow
  isAnchor: boolean
  isSelected: boolean
}) {
  const src = useMediaUrl(photo.id, 'thumb')
  const classes = ['thumb', isAnchor ? 'sel' : isSelected ? 'batch' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} title={photo.filename}>
      {src !== undefined && (
        // key=src: react-window recycles slots by index, so a new photo in this
        // slot must remount the img — otherwise an inline error style from the
        // previous photo would keep the good replacement hidden.
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          // The wrapper cell owns the drag; suppress the browser's native image drag.
          draggable={false}
          // Missing or not-yet-built thumbs keep the gray placeholder instead of a broken-image glyph.
          onError={(e) => {
            e.currentTarget.style.visibility = 'hidden'
          }}
        />
      )}
      {isSelected && (
        <span className={isAnchor ? 'check' : 'check orange'}>
          <CheckIcon size={10} />
        </span>
      )}
      {photo.missing === 1 && (
        <span className="thumb-warn" title="原文件缺失">
          <WarningIcon size={10} />
        </span>
      )}
      <span className="fname-tag">{stripExt(photo.filename)}</span>
    </div>
  )
}

// react-window renders a fixed column count, so the final row may ask for a
// cell beyond the data; keep the hook-containing component below this guard so
// React's rules of hooks are never violated.
export default function GridCell({
  rowIndex,
  columnIndex,
  style,
  ariaAttributes,
  photos,
  selected,
  anchorId,
  onToggle,
  onDragStart
}: GridCellProps) {
  const photo = photos[rowIndex * 2 + columnIndex]
  if (photo === undefined) return null

  return (
    <div
      className="thumb-cell"
      style={style}
      {...ariaAttributes}
      draggable
      onDragStart={(e) => onDragStart(photo.id, e)}
      onClick={(e) =>
        onToggle(photo.id, {
          ctrl: e.ctrlKey || e.metaKey,
          shift: e.shiftKey
        })
      }
    >
      <ThumbCell
        photo={photo}
        isAnchor={photo.id === anchorId}
        isSelected={selected.has(photo.id)}
      />
    </div>
  )
}
