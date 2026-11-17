import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MediaQueue } from '../../electron/media/queue'
import { retryMediaGeneration } from '../../electron/media/retry'

const dirs: string[] = []

function tempRoots(): { thumbDir: string; previewDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-retry-'))
  dirs.push(root)
  const thumbDir = path.join(root, 'thumbnails')
  const previewDir = path.join(root, 'previews')
  fs.mkdirSync(thumbDir, { recursive: true })
  fs.mkdirSync(previewDir, { recursive: true })
  return { thumbDir, previewDir }
}

function recordingQueues(): {
  thumb: Pick<MediaQueue, 'enqueue'>
  photo: Pick<MediaQueue, 'enqueue'>
  calls: { thumb: number[][]; photo: number[][] }
} {
  const calls = { thumb: [] as number[][], photo: [] as number[][] }
  return {
    calls,
    thumb: { enqueue: (ids) => calls.thumb.push([...ids]) },
    photo: { enqueue: (ids) => calls.photo.push([...ids]) }
  }
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('retryMediaGeneration', () => {
  it('removes the failed thumbnail and sidecar, then re-enqueues the thumb id', () => {
    const roots = tempRoots()
    const q = recordingQueues()
    const thumb = path.join(roots.thumbDir, '7.jpg')
    fs.writeFileSync(thumb, 'placeholder-bytes')
    fs.writeFileSync(`${thumb}.placeholder`, '')

    retryMediaGeneration(roots, 'thumb', 7, q)

    expect(fs.existsSync(thumb)).toBe(false)
    expect(fs.existsSync(`${thumb}.placeholder`)).toBe(false)
    expect(q.calls.thumb).toEqual([[7]])
    expect(q.calls.photo).toEqual([])
  })

  it('removes the failed preview and re-enqueues the photo id', () => {
    const roots = tempRoots()
    const q = recordingQueues()
    const preview = path.join(roots.previewDir, '9.jpg')
    fs.writeFileSync(preview, 'placeholder-bytes')
    fs.writeFileSync(`${preview}.placeholder`, '')

    retryMediaGeneration(roots, 'photo', 9, q)

    expect(fs.existsSync(preview)).toBe(false)
    expect(q.calls.photo).toEqual([[9]])
    expect(q.calls.thumb).toEqual([])
  })

  it('still enqueues when no cached artifact exists yet, and never touches source files', () => {
    const roots = tempRoots()
    const q = recordingQueues()
    const source = path.join(dirs[0], 'outside.jpg')
    fs.writeFileSync(source, 'source')

    retryMediaGeneration(roots, 'thumb', 11, q)

    expect(q.calls.thumb).toEqual([[11]])
    expect(fs.readFileSync(source, 'utf8')).toBe('source')
  })
})
