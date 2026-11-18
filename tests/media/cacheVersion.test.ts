import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CACHE_VERSION_FILE,
  MEDIA_CACHE_VERSION,
  planCacheVersionReset,
  resetMediaCacheIfStale
} from '../../electron/media/cacheVersion'
import type { MediaRoots } from '../../electron/media/resolve'

const dirs: string[] = []

function makeLayout(): { userData: string; roots: MediaRoots } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-cv-'))
  dirs.push(base)
  const userData = path.join(base, 'userdata')
  const roots = {
    thumbDir: path.join(userData, 'thumbnails'),
    previewDir: path.join(userData, 'previews')
  }
  fs.mkdirSync(roots.thumbDir, { recursive: true })
  fs.mkdirSync(roots.previewDir, { recursive: true })
  return { userData, roots }
}

afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('planCacheVersionReset', () => {
  it('marks the cache stale and lists both dirs when no version file exists', () => {
    const { userData, roots } = makeLayout()
    const plan = planCacheVersionReset(roots, userData)
    expect(plan.stale).toBe(true)
    expect(plan.dirs).toEqual([roots.thumbDir, roots.previewDir])
  })

  it('is current when the version file matches', () => {
    const { userData, roots } = makeLayout()
    fs.writeFileSync(path.join(userData, CACHE_VERSION_FILE), String(MEDIA_CACHE_VERSION))
    const plan = planCacheVersionReset(roots, userData)
    expect(plan.stale).toBe(false)
    expect(plan.dirs).toEqual([])
  })

  it('is stale when the version file holds an older version', () => {
    const { userData, roots } = makeLayout()
    fs.writeFileSync(path.join(userData, CACHE_VERSION_FILE), String(MEDIA_CACHE_VERSION - 1))
    expect(planCacheVersionReset(roots, userData).stale).toBe(true)
  })
})

describe('resetMediaCacheIfStale', () => {
  it('wipes and recreates both cache dirs and persists the current version', () => {
    const { userData, roots } = makeLayout()
    fs.writeFileSync(path.join(roots.thumbDir, '1.jpg'), 'x')
    fs.writeFileSync(path.join(roots.previewDir, '2.jpg.placeholder'), '')
    fs.writeFileSync(path.join(roots.previewDir, '2.jpg.tmp'), 'partial')

    const result = resetMediaCacheIfStale(roots, userData)

    expect(result.reset).toBe(true)
    expect(fs.readdirSync(roots.thumbDir)).toEqual([])
    expect(fs.readdirSync(roots.previewDir)).toEqual([])
    expect(fs.readFileSync(path.join(userData, CACHE_VERSION_FILE), 'utf8')).toBe(
      String(MEDIA_CACHE_VERSION)
    )
  })

  it('is a no-op on the second run and leaves freshly generated artifacts alone', () => {
    const { userData, roots } = makeLayout()
    expect(resetMediaCacheIfStale(roots, userData).reset).toBe(true)
    fs.writeFileSync(path.join(roots.thumbDir, '9.jpg'), 'x')

    expect(resetMediaCacheIfStale(roots, userData).reset).toBe(false)
    expect(fs.existsSync(path.join(roots.thumbDir, '9.jpg'))).toBe(true)
  })
})
