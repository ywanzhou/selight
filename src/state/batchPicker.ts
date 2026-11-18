// DOM-free helpers for the custom batch picker popover, unit-tested under
// bare Node. The component owns focus and DOM events; these own the index
// math and the relative date copy.

export type PickerDirection = 1 | -1

/**
 * Cyclic active-row movement for the picker's ArrowUp/ArrowDown handling.
 * Empty lists stay at 0. An out-of-range current index (e.g. after the batch
 * list reloads) re-enters at the edge the movement direction points at.
 */
export function moveActiveIndex(
  current: number,
  length: number,
  direction: PickerDirection
): number {
  if (length <= 0) return 0
  if (current < 0 || current >= length) {
    return direction === 1 ? 0 : length - 1
  }
  return (current + direction + length) % length
}

/**
 * Subtitle copy for a batch option, relative to the injected `now`
 * (defaults to the machine clock; tests pass a fixed value): same calendar
 * day says "today", same year drops the year prefix, older dates keep it.
 */
export function formatBatchDate(createdAt: number, now: number = Date.now()): string {
  const created = new Date(createdAt)
  const today = new Date(now)
  const sameDay =
    created.getFullYear() === today.getFullYear() &&
    created.getMonth() === today.getMonth() &&
    created.getDate() === today.getDate()
  if (sameDay) return '今天创建'

  const month = created.getMonth() + 1
  const day = created.getDate()
  if (created.getFullYear() === today.getFullYear()) {
    return `${month} 月 ${day} 日创建`
  }
  return `${created.getFullYear()} 年 ${month} 月 ${day} 日创建`
}
