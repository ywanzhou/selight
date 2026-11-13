import { describe, expect, it } from 'vitest'
import { shortcutToAction } from '../../src/state/shortcuts'

// DOM-free table tests for the key → action mapper. The function never touches
// the event itself: returning a non-null action is the contract the hook uses to
// decide preventDefault, so prevention is deliberately NOT asserted here.

interface KeyInfo {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
}

function k(partial: KeyInfo): { key: string; ctrlKey: boolean; metaKey: boolean } {
  return { ctrlKey: false, metaKey: false, ...partial }
}

describe('shortcutToAction navigation', () => {
  const cases = [
    ['ArrowLeft', { type: 'navigate', dir: -1 }],
    ['ArrowUp', { type: 'navigate', dir: -1 }],
    ['ArrowRight', { type: 'navigate', dir: 1 }],
    ['ArrowDown', { type: 'navigate', dir: 1 }]
  ] as const
  for (const [key, expected] of cases) {
    it(`maps ${key} to navigate ${expected.dir}`, () => {
      expect(shortcutToAction(k({ key }), 3, false)).toEqual(expected)
    })
  }

  it('clamps nothing itself — arrows always resolve, the model clamps at the ends', () => {
    expect(shortcutToAction(k({ key: 'ArrowLeft' }), 0, false)).toEqual({
      type: 'navigate',
      dir: -1
    })
  })
})

describe('shortcutToAction digit assignment', () => {
  it('maps digits 1-9 to folderIndex n-1 while n <= folderCount', () => {
    expect(shortcutToAction(k({ key: '1' }), 3, false)).toEqual({
      type: 'assign',
      folderIndex: 0
    })
    expect(shortcutToAction(k({ key: '2' }), 3, false)).toEqual({
      type: 'assign',
      folderIndex: 1
    })
    expect(shortcutToAction(k({ key: '3' }), 3, false)).toEqual({
      type: 'assign',
      folderIndex: 2
    })
  })

  it('returns null for digits beyond the folder count', () => {
    expect(shortcutToAction(k({ key: '4' }), 3, false)).toBeNull()
    expect(shortcutToAction(k({ key: '9' }), 3, false)).toBeNull()
  })

  it('returns null for every digit when no folders exist', () => {
    for (const digit of ['1', '2', '9']) {
      expect(shortcutToAction(k({ key: digit }), 0, false)).toBeNull()
    }
  })

  it('maps the ninth folder at the boundary folderCount=9', () => {
    expect(shortcutToAction(k({ key: '9' }), 9, false)).toEqual({
      type: 'assign',
      folderIndex: 8
    })
  })
})

describe('shortcutToAction destructive / undo keys', () => {
  it('maps both Delete and Backspace to trash', () => {
    expect(shortcutToAction(k({ key: 'Delete' }), 0, false)).toEqual({ type: 'trash' })
    expect(shortcutToAction(k({ key: 'Backspace' }), 0, false)).toEqual({ type: 'trash' })
  })

  it('maps Ctrl+Z, Meta+Z and both-held-together to undo', () => {
    expect(shortcutToAction(k({ key: 'z', ctrlKey: true }), 0, false)).toEqual({
      type: 'undo'
    })
    expect(shortcutToAction(k({ key: 'z', metaKey: true }), 0, false)).toEqual({
      type: 'undo'
    })
    expect(
      shortcutToAction(k({ key: 'z', ctrlKey: true, metaKey: true }), 0, false)
    ).toEqual({ type: 'undo' })
    // Shift yields an uppercase key; undo must still resolve.
    expect(shortcutToAction(k({ key: 'Z', ctrlKey: true }), 0, false)).toEqual({
      type: 'undo'
    })
  })

  it('does not treat a bare z as undo', () => {
    expect(shortcutToAction(k({ key: 'z' }), 0, false)).toBeNull()
  })

  it('maps Escape to backToInbox', () => {
    expect(shortcutToAction(k({ key: 'Escape' }), 0, false)).toEqual({
      type: 'backToInbox'
    })
  })

  it('maps Ctrl/Cmd+A to selectAll but not a bare a', () => {
    expect(shortcutToAction(k({ key: 'a', ctrlKey: true }), 0, false)).toEqual({
      type: 'selectAll'
    })
    expect(shortcutToAction(k({ key: 'a', metaKey: true }), 0, false)).toEqual({
      type: 'selectAll'
    })
    expect(shortcutToAction(k({ key: 'a' }), 0, false)).toBeNull()
  })
})

describe('shortcutToAction input guard', () => {
  // Every otherwise-mapped key must surrender while a text input is focused.
  const mappedKeys: KeyInfo[] = [
    { key: 'ArrowLeft' },
    { key: 'ArrowRight' },
    { key: '1' },
    { key: '9' },
    { key: 'Delete' },
    { key: 'Backspace' },
    { key: 'Escape' },
    { key: 'z', ctrlKey: true },
    { key: 'a', metaKey: true }
  ]
  for (const info of mappedKeys) {
    it(`returns null for ${info.key} when inInput=true`, () => {
      expect(shortcutToAction(k(info), 9, true)).toBeNull()
    })
  }
})

describe('shortcutToAction unmapped keys', () => {
  for (const key of ['Enter', 'Tab', 'x', ' ', '0', 'F1']) {
    it(`returns null for ${JSON.stringify(key)}`, () => {
      expect(shortcutToAction(k({ key }), 9, false)).toBeNull()
    })
  }
})
