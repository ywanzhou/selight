import { useEffect, useRef, useState } from 'react'
import type { BatchRow } from '../../electron/shared/api'
import { formatBatchDate, moveActiveIndex, type PickerDirection } from '../state/batchPicker'
import { CheckIcon, ChevronDownIcon } from './icons'

interface BatchPickerProps {
  batches: BatchRow[]
  batchId: number | null
  loading: boolean
  onOpen: (batchId: number) => void
}

const MENU_MIN_WIDTH = 230
// Keep this much clear space between the menu and the viewport's right edge.
const VIEWPORT_EDGE = 18

// Custom popover replacing the native <select>: the OS-drawn option list could
// not match the app's frosted visual language or show batch metadata. Open/close
// and key ownership mirror FolderCards' FolderContextMenu.
export default function BatchPicker({ batches, batchId, loading, onOpen }: BatchPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuLeft, setMenuLeft] = useState(0)

  const disabled = batches.length === 0 || loading
  const currentIndex = batches.findIndex((batch) => batch.id === batchId)
  const currentName = currentIndex >= 0 ? batches[currentIndex].name : ''

  function openMenu(): void {
    if (disabled) return
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0)
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect) {
      // Negative offset pulls the absolute menu left when the trigger is near
      // the right viewport edge; otherwise it aligns with the trigger.
      const overflow = window.innerWidth - VIEWPORT_EDGE - MENU_MIN_WIDTH - rect.left
      setMenuLeft(overflow < 0 ? overflow : 0)
    } else {
      setMenuLeft(0)
    }
    setOpen(true)
  }

  function choose(index: number): void {
    const batch = batches[index]
    if (batch === undefined) return
    setOpen(false)
    triggerRef.current?.focus()
    if (batch.id !== batchId) onOpen(batch.id)
  }

  function move(direction: PickerDirection): void {
    setActiveIndex((prev) => moveActiveIndex(prev, batches.length, direction))
  }

  // Move DOM focus together with the active row so keyboard scroll/focus stays
  // inside the popover.
  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  // While open, the popover owns every key: capture-phase stopPropagation runs
  // before the bubble-phase global shortcut listener, so digit/Delete/Ctrl+Z
  // can never move photos behind the menu. Same contract as FolderContextMenu.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent): void {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        choose(activeIndex)
      }
    }
    function onPointerDown(e: PointerEvent): void {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onScroll(e: Event): void {
      // Scrolling inside the now-scrollable menu must not dismiss it; only
      // outside scroll (thumbnail grid etc.) closes the popover.
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function close(): void {
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
    }
    // activeIndex/batches/batchId re-subscribe so the handler closure is never stale.
  }, [open, activeIndex, batches, batchId])

  return (
    <div className="batch-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tb-picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="选择批次"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          // Enter/Space fall through to the native click toggle; only ArrowDown
          // needs an explicit open, and preventDefault stops the page scroll.
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            openMenu()
          }
        }}
      >
        <span className="bp-label">{batches.length === 0 ? '无批次' : currentName}</span>
        <ChevronDownIcon size={12} className="bp-chev" />
      </button>

      {open && (
        <div
          className="batch-menu"
          role="listbox"
          aria-label="选择批次"
          style={{ left: `${menuLeft}px` }}
        >
          {batches.map((batch, index) => {
            const selected = batch.id === batchId
            return (
              <button
                key={batch.id}
                ref={(el) => {
                  optionRefs.current[index] = el
                }}
                type="button"
                role="option"
                aria-selected={selected}
                className={index === activeIndex ? 'batch-option active' : 'batch-option'}
                onClick={() => choose(index)}
              >
                <CheckIcon
                  size={14}
                  className={selected ? 'bo-check' : 'bo-check placeholder'}
                />
                <span className="bo-text">
                  <span className="bo-name">{batch.name}</span>
                  <span className="bo-date">{formatBatchDate(batch.createdAt)}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
