import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'

// Real sharp(libvips) decode runs under bare-node Vitest via prebuilt N-API
// binaries, so no electron mock is needed; the full thumbnail path is exercised
// against the real corpus here, with the Electron harness
// tests/smoke/electron-media-harness.cjs proving the same path inside a real
// Electron process (RSS, process-tree cleanup).
import sharp from 'sharp'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { createFolder, listFolders } from '../../electron/domain/folders'
import { counts, listPhotos, type PhotoStatus } from '../../electron/domain/photos'
import { assignToFolder, moveToTrash } from '../../electron/domain/classify'
import { undoLastGroup } from '../../electron/domain/actions'
import { importScanned, scanDirectory, type ScannedFile } from '../../electron/scanner'
import { exportBatch } from '../../electron/exporter'
import {
  createThumbnailQueue,
  ensureThumbnail,
  type ThumbnailPhoto
} from '../../electron/media/thumbnails'

// The real corpus is never created or modified by this suite: every DB, cache and
// export lands in os.tmpdir(), and the scanner only opens source files read-only.
const CORPUS = path.resolve(__dirname, '..', '..', '素材')

// Mirrors scanner.ts SUPPORTED_EXT (not exported); the smoke walk must count exactly
// the files the scanner is expected to import.
const SUPPORTED_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.arw',
  '.cr2',
  '.cr3',
  '.nef',
  '.dng',
  '.raf',
  '.rw2',
  '.orf',
  '.pef',
  '.srw'
])

// Fixed seed so every classification/trash decision and sample is reproducible.
const SEED = 20261114

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(input: readonly T[], rng: () => number): T[] {
  const out = [...input]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function walkFiles(dir: string, supportedOnly: boolean): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, supportedOnly))
    } else if (
      entry.isFile() &&
      (!supportedOnly || SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase()))
    ) {
      out.push(abs)
    }
  }
  return out
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

const suite = fs.existsSync(CORPUS) ? describe : describe.skip
// The real ExifTool scan over ~1.9k files needs minutes, not the 5s default.
const SLOW = 300_000
const slowIt = (name: string, fn: () => void | Promise<void>): void => {
  vitestIt(name, fn, SLOW)
}

suite('smoke: real 素材 corpus full flow (webp, ~1.9k photos)', () => {
  const dirs: string[] = []
  let dbFile = ''
  let db: Database
  let batchId = -1
  let thumbDir = ''
  let previewDir = ''
  let exportDir = ''
  let scanned: ScannedFile[] = []

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-smoke-'))
    dirs.push(root)
    dbFile = path.join(root, 'smoke.db')
    db = openDatabase(dbFile).db
    thumbDir = path.join(root, 'thumbs')
    previewDir = path.join(root, 'previews')
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-smoke-export-'))
    dirs.push(exportDir)
    batchId = createBatch(db, 'smoke batch').id
  })

  afterAll(async () => {
    if (db?.open) db.close()
    while (dirs.length) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  }, SLOW)

  // ------------------------------------------------------------------ 1. import
  slowIt('imports the full tree: photo count equals disk count, zero duplicate paths, sane failures', async () => {
    const expectedPaths = walkFiles(CORPUS, true).sort()

    const tScan0 = performance.now()
    const scan = await scanDirectory(CORPUS)
    const scanMs = performance.now() - tScan0
    scanned = scan.files

    expect(scan.failures).toEqual([])
    expect(scanned).toHaveLength(expectedPaths.length)
    expect(scanned.map((f) => f.absPath).sort()).toEqual(expectedPaths)

    const sourceId = Number(
      db
        .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
        .run(batchId, CORPUS).lastInsertRowid
    )

    const tImport0 = performance.now()
    const first = importScanned(db, batchId, sourceId, scanned)
    const importMs = performance.now() - tImport0
    // eslint-disable-next-line no-console
    console.log(
      `[smoke] fs scan ${round1(scanMs)}ms (${scanned.length} files), ` +
        `first importScanned ${round1(importMs)}ms`
    )

    expect(first).toEqual({ added: scanned.length, updated: 0, missing: 0 })

    // Re-running the same scan output adds nothing: the ON CONFLICT path counts every
    // existing row as updated (pinned by scanner.test.ts), while the skipped WHERE means
    // updated_at must stay byte-identical, proving the no-op data semantics.
    const maxUpdatedAt = (
      db.prepare('SELECT MAX(updated_at) AS m FROM photos WHERE batch_id = ?').get(batchId) as {
        m: number
      }
    ).m
    const second = importScanned(db, batchId, sourceId, scanned)
    expect(second).toEqual({ added: 0, updated: scanned.length, missing: 0 })
    expect(
      (db.prepare('SELECT MAX(updated_at) AS m FROM photos WHERE batch_id = ?').get(batchId) as {
        m: number
      }).m
    ).toBe(maxUpdatedAt)

    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT abs_path) AS d,
                COALESCE(SUM(status = 'inbox'), 0) AS inbox,
                COALESCE(SUM(missing = 1), 0) AS missing
         FROM photos WHERE batch_id = ?`
      )
      .get(batchId) as { n: number; d: number; inbox: number; missing: number }
    expect(row.n).toBe(expectedPaths.length)
    expect(row.d).toBe(row.n)
    expect(row.inbox).toBe(expectedPaths.length)
    expect(row.missing).toBe(0)
  })

  // --------------------------------------------------------- 2. classify + undo
  slowIt('deterministically assigns 200, trashes 50, undoes 3 groups, and matches the shadow model', () => {
    interface Shadow {
      status: PhotoStatus
      folderId: number | null
    }
    interface Op {
      id: number
      from: Shadow
      to: Shadow
    }
    const allIds = (
      db.prepare('SELECT id FROM photos ORDER BY id').all() as { id: number }[]
    ).map((r) => r.id)
    const rng = mulberry32(SEED)
    const shuffled = shuffle(allIds, rng)

    const folders = []
    for (let k = 0; k < 6; k += 1) {
      folders.push(createFolder(db, batchId, `分类 ${k + 1}`))
    }

    const shadow = new Map<number, Shadow>()
    for (const id of allIds) shadow.set(id, { status: 'inbox', folderId: null })
    const groupLog: Op[][] = [[], [], [], [], [], [], [], []]

    // 200 photos split into 6 assign groups (one group per folder), ~33 photos each.
    const assigned = shuffled.slice(0, 200)
    for (let k = 0; k < 6; k += 1) {
      const ids = assigned.filter((_, i) => i % 6 === k)
      assignToFolder(db, ids, folders[k].id)
      for (const id of ids) {
        const from = { ...shadow.get(id)! }
        const to: Shadow = { status: 'folder', folderId: folders[k].id }
        groupLog[k].push({ id, from, to })
        shadow.set(id, { ...to })
      }
    }

    // 50 distinct photos trashed as two groups (groups 7 and 8).
    const trashPick = shuffled.slice(200, 250)
    for (let g = 0; g < 2; g += 1) {
      const ids = trashPick.slice(g * 25, (g + 1) * 25)
      moveToTrash(db, ids)
      for (const id of ids) {
        const from = { ...shadow.get(id)! }
        const to: Shadow = { status: 'trash', folderId: null }
        groupLog[6 + g].push({ id, from, to })
        shadow.set(id, { ...to })
      }
    }

    // Three undos revert groups 8, 7 and 6 in that order.
    for (const g of [8, 7, 6]) {
      expect(undoLastGroup(db, batchId)).toBe(true)
      for (const op of groupLog[g - 1]) shadow.set(op.id, { ...op.from })
    }

    // Every single row must agree with the same deterministic sequence replayed in JS.
    const rows = db
      .prepare('SELECT id, status, folder_id AS folderId FROM photos')
      .all() as { id: number; status: PhotoStatus; folderId: number | null }[]
    expect(rows).toHaveLength(allIds.length)
    for (const row of rows) {
      const expected = shadow.get(row.id)!
      expect(row.status).toBe(expected.status)
      expect(row.folderId).toBe(expected.folderId)
    }

    const expectedCounts = { total: allIds.length, inbox: 0, folder: 0, trash: 0 }
    for (const state of shadow.values()) expectedCounts[state.status] += 1
    expect(counts(db, batchId)).toEqual(expectedCounts)
    expect(expectedCounts.trash).toBe(0)

    const flags = db
      .prepare(
        `SELECT batch_id_group AS g, MAX(undone) AS undone, COUNT(*) AS n
         FROM actions WHERE batch_id = ? GROUP BY batch_id_group ORDER BY g`
      )
      .all(batchId) as { g: number; undone: number; n: number }[]
    expect(flags).toHaveLength(8)
    for (const flag of flags) {
      expect(flag.undone).toBe(flag.g >= 6 ? 1 : 0)
      expect(flag.n).toBe(groupLog[flag.g - 1].length)
    }

    // Sample action rows carry the real from/to state the undo replayed.
    const sample = [groupLog[0][0], groupLog[6][0]]
    for (const [index, op] of sample.entries()) {
      const action = db
        .prepare(
          `SELECT from_status AS fromStatus, to_status AS toStatus, undone
           FROM actions WHERE batch_id = ? AND photo_id = ? AND batch_id_group = ?`
        )
        .get(batchId, op.id, index === 0 ? 1 : 7) as {
        fromStatus: PhotoStatus
        toStatus: PhotoStatus
        undone: number
      }
      expect(action.fromStatus).toBe(op.from.status)
      expect(action.toStatus).toBe(op.to.status)
    }
  })

  // ---------------------------------------------------------------- 3. thumbnails
  slowIt('drains the thumbnail queue over 20 real webp rows with sharp JPEG cache files and sidecar contract', async () => {
    const webpRows = db
      .prepare(
        `SELECT id, abs_path AS absPath, ext, orientation, missing
         FROM photos WHERE ext = '.webp' ORDER BY id`
      )
      .all() as ThumbnailPhoto[]
    expect(webpRows.length).toBeGreaterThan(100)
    const stride = Math.floor(webpRows.length / 20)
    const sample = webpRows.filter((_, i) => i % stride === 0).slice(0, 20)
    expect(sample).toHaveLength(20)

    const queue = createThumbnailQueue(db, { thumbDir, previewDir })
    const drain = (ids: number[]): Promise<void> =>
      new Promise((resolve) => {
        queue.onIdle(() => resolve())
        queue.enqueue(ids)
      })

    await drain(sample.map((p) => p.id))

    for (const photo of sample) {
      // The real corpus path stays read-only and existing on disk.
      expect(fs.existsSync(photo.absPath)).toBe(true)
      const file = path.join(thumbDir, `${photo.id}.jpg`)
      expect(fs.existsSync(file)).toBe(true)
      const bytes = fs.readFileSync(file)
      expect(bytes.length).toBeGreaterThan(0)
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
      expect(fs.existsSync(`${file}.placeholder`)).toBe(false)
      // Real sharp decode: the long edge is exactly the 320px thumbnail target.
      const meta = await sharp(file).metadata()
      expect(Math.max(meta.width!, meta.height!)).toBe(320)
    }

    // Second drain: disk cache hits must not rewrite any file (mtime invariant).
    const mtimes = sample.map((p) =>
      fs.statSync(path.join(thumbDir, `${p.id}.jpg`)).mtimeMs
    )
    await drain(sample.map((p) => p.id))
    sample.forEach((p, i) => {
      expect(fs.statSync(path.join(thumbDir, `${p.id}.jpg`)).mtimeMs).toBe(mtimes[i])
    })

    // Placeholder sidecar for a missing photo: decoder never runs, marker persists.
    const missingPhoto = webpRows.find((p) => !sample.some((s) => s.id === p.id))!
    db.prepare('UPDATE photos SET missing = 1 WHERE id = ?').run(missingPhoto.id)
    const missingRow = db
      .prepare(
        'SELECT id, abs_path AS absPath, ext, orientation, missing FROM photos WHERE id = ?'
      )
      .get(missingPhoto.id) as ThumbnailPhoto
    const missingResult = await ensureThumbnail(missingRow, thumbDir)
    const missingFile = path.join(thumbDir, `${missingPhoto.id}.jpg`)
    expect(missingResult.placeholder).toBe(true)
    expect(fs.existsSync(`${missingFile}.placeholder`)).toBe(true)
    expect(fs.readFileSync(missingFile).subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff])
    )
    db.prepare('UPDATE photos SET missing = 0 WHERE id = ?').run(missingPhoto.id)

    // Failure/recovery on an isolated tmp row: the read-only corpus never gets
    // a broken file. Zero-byte source -> placeholder; valid JPEG replacement ->
    // a real thumbnail with the sidecar cleared.
    const tmpSource = path.join(path.dirname(thumbDir), 'recovery-case.jpg')
    fs.writeFileSync(tmpSource, Buffer.alloc(0))
    const tmpSourceId = Number(
      db
        .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
        .run(batchId, tmpSource).lastInsertRowid
    )
    const tmpPhotoId = Number(
      db
        .prepare(
          `INSERT INTO photos
             (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, orientation, status, missing)
           VALUES (?, ?, ?, 'recovery-case.jpg', '.jpg', 0, 1, 1, 'inbox', 0)`
        )
        .run(batchId, tmpSourceId, tmpSource).lastInsertRowid
    )
    const tmpRow = db
      .prepare(
        'SELECT id, abs_path AS absPath, ext, orientation, missing FROM photos WHERE id = ?'
      )
      .get(tmpPhotoId) as ThumbnailPhoto
    const failed = await ensureThumbnail(tmpRow, thumbDir)
    const tmpThumb = path.join(thumbDir, `${tmpPhotoId}.jpg`)
    expect(failed.placeholder).toBe(true)
    expect(fs.existsSync(`${tmpThumb}.placeholder`)).toBe(true)

    fs.rmSync(tmpThumb, { force: true })
    fs.rmSync(`${tmpThumb}.placeholder`, { force: true })
    fs.writeFileSync(
      tmpSource,
      await sharp({
        create: {
          width: 640,
          height: 480,
          channels: 3,
          background: { r: 12, g: 34, b: 56, alpha: 1 }
        }
      })
        .jpeg()
        .toBuffer()
    )
    const recovered = await ensureThumbnail(tmpRow, thumbDir)
    expect(recovered.placeholder).toBe(false)
    expect(fs.existsSync(`${tmpThumb}.placeholder`)).toBe(false)
    const recoveredMeta = await sharp(tmpThumb).metadata()
    expect(recoveredMeta.width).toBe(320)
    queue.stop()
  })

  // ------------------------------------------------- 4. Ruling 16 timing at 6 folders
  slowIt('measures renderer refresh cost at 1871-photo scale with 6 folders', () => {
    const folderIds = listFolders(db, batchId).map((f) => f.id)
    expect(folderIds).toHaveLength(6)

    interface Round {
      total: number
      inbox: number
      counts: number
      fanout: number
    }
    const runOnce = (): Round => {
      const t0 = performance.now()
      const inboxPhotos = listPhotos(db, batchId, { kind: 'inbox' })
      const tInbox = performance.now()
      const c = counts(db, batchId)
      const tCounts = performance.now()
      listFolders(db, batchId)
      const tFolders = performance.now()
      const fanCounts = folderIds.map(
        (id) => listPhotos(db, batchId, { kind: 'folder', folderId: id }).length
      )
      const total = performance.now() - t0
      // Functional checks alongside the timing: both pull paths match counts().
      expect(inboxPhotos).toHaveLength(c.inbox)
      expect(fanCounts.reduce((a, b) => a + b, 0)).toBe(c.folder)
      return {
        total,
        inbox: tInbox - t0,
        counts: tCounts - tInbox,
        fanout: performance.now() - tFolders
      }
    }

    for (let i = 0; i < 3; i += 1) runOnce()
    const rounds: Round[] = []
    for (let i = 0; i < 20; i += 1) rounds.push(runOnce())
    const totals = rounds.map((r) => r.total)
    // eslint-disable-next-line no-console
    console.log(
      `[smoke] refresh @6 folders / ${counts(db, batchId).total} photos, 20 runs: ` +
        `total p50=${round1(percentile(totals, 0.5))}ms p95=${round1(
          percentile(totals, 0.95)
        )}ms | inbox p95=${round1(
          percentile(
            rounds.map((r) => r.inbox),
            0.95
          )
        )}ms counts p95=${round1(
          percentile(
            rounds.map((r) => r.counts),
            0.95
          )
        )}ms fan-out p95=${round1(
          percentile(
            rounds.map((r) => r.fanout),
            0.95
          )
        )}ms`
    )
    expect(percentile(totals, 0.95)).toBeGreaterThan(0)
    // T18 review Minor 2: loose anti-regression ceiling, wide enough never to flap CI.
    expect(percentile(totals, 0.95)).toBeLessThan(250)
  })

  // ------------------------------------------------------- 5. restart persistence
  slowIt('survives a database close/reopen and still undoes', () => {
    const snapshot = {
      counts: counts(db, batchId),
      folders: listFolders(db, batchId).length,
      photos: Number(
        (
          db.prepare('SELECT COUNT(*) AS n FROM photos WHERE batch_id = ?').get(batchId) as {
            n: number
          }
        ).n
      ),
      folderIdSum: Number(
        (
          db
            .prepare('SELECT COALESCE(SUM(folder_id), 0) AS s FROM photos')
            .get() as { s: number }
        ).s
      ),
      undoneGroups: (
        db
          .prepare(
            'SELECT batch_id_group AS g, MAX(undone) AS u FROM actions GROUP BY batch_id_group'
          )
          .all() as { g: number; u: number }[]
      ).map((r) => `${r.g}:${r.u}`)
    }

    db.close()
    db = openDatabase(dbFile).db

    expect(counts(db, batchId)).toEqual(snapshot.counts)
    expect(listFolders(db, batchId)).toHaveLength(snapshot.folders)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM photos WHERE batch_id = ?').get(batchId) as {
        n: number
      }).n
    ).toBe(snapshot.photos)
    expect(
      (db.prepare('SELECT COALESCE(SUM(folder_id), 0) AS s FROM photos').get() as {
        s: number
      }).s
    ).toBe(snapshot.folderIdSum)
    expect(
      (
        db
          .prepare(
            'SELECT batch_id_group AS g, MAX(undone) AS u FROM actions GROUP BY batch_id_group'
          )
          .all() as { g: number; u: number }[]
      ).map((r) => `${r.g}:${r.u}`)
    ).toEqual(snapshot.undoneGroups)

    // Fourth undo reverts group 5 (the most recent group still active) after restart.
    const group5Photos = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM actions WHERE batch_id_group = 5 AND photo_id IS NOT NULL"
          )
          .get() as { n: number }
      ).n
    )
    const before = counts(db, batchId)
    expect(undoLastGroup(db, batchId)).toBe(true)
    const after = counts(db, batchId)
    expect(before.folder - after.folder).toBe(group5Photos)
    expect(
      (
        db
          .prepare('SELECT MAX(undone) AS u FROM actions WHERE batch_id_group = 5')
          .get() as { u: number }
      ).u
    ).toBe(1)
  })

  // ------------------------------ 6. Ruling 16 stress: 50 extra folders, one photo each
  slowIt('measures the fan-out stress point at 56 folders', () => {
    const rng = mulberry32(SEED + 1)
    const inboxIds = (
      db
        .prepare("SELECT id FROM photos WHERE status = 'inbox' ORDER BY id")
        .all() as { id: number }[]
    ).map((r) => r.id)
    const picked = shuffle(inboxIds, rng).slice(0, 50)
    expect(picked).toHaveLength(50)
    const stressFolders = []
    for (let i = 0; i < 50; i += 1) {
      stressFolders.push(createFolder(db, batchId, `压力 ${String(i + 1).padStart(2, '0')}`))
    }
    for (let i = 0; i < 50; i += 1) {
      assignToFolder(db, [picked[i]], stressFolders[i].id)
    }

    const folderIds = listFolders(db, batchId).map((f) => f.id)
    expect(folderIds).toHaveLength(56)

    const runOnce = (): number => {
      const t0 = performance.now()
      listPhotos(db, batchId, { kind: 'inbox' })
      counts(db, batchId)
      listFolders(db, batchId)
      const fanCounts = folderIds.map(
        (id) => listPhotos(db, batchId, { kind: 'folder', folderId: id }).length
      )
      expect(fanCounts.reduce((a, b) => a + b, 0)).toBe(counts(db, batchId).folder)
      return performance.now() - t0
    }
    for (let i = 0; i < 3; i += 1) runOnce()
    const totals: number[] = []
    for (let i = 0; i < 20; i += 1) totals.push(runOnce())
    // eslint-disable-next-line no-console
    console.log(
      `[smoke] refresh @56 folders / ${counts(db, batchId).total} photos, 20 runs: ` +
        `total p50=${round1(percentile(totals, 0.5))}ms p95=${round1(
          percentile(totals, 0.95)
        )}ms`
    )
    expect(percentile(totals, 0.95)).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------- 7. export
  slowIt('exports folder photos into temp subdirs, excludes trash, and never mutates the corpus', async () => {
    // A fresh trash group gives the exclusion assertion something real to catch.
    const rng = mulberry32(SEED + 2)
    const inboxIds = shuffle(
      (
        db
          .prepare("SELECT id FROM photos WHERE status = 'inbox' ORDER BY id")
          .all() as { id: number }[]
      ).map((r) => r.id),
      rng
    ).slice(0, 10)
    moveToTrash(db, inboxIds)
    expect(counts(db, batchId).trash).toBe(10)
    const trashedNames = new Set(
      (
        db
          .prepare(
            `SELECT filename FROM photos WHERE status = 'trash' AND batch_id = ?`
          )
          .all(batchId) as { filename: string }[]
      ).map((r) => r.filename)
    )

    const allCorpusFiles = walkFiles(CORPUS, false).sort()
    const statSample = allCorpusFiles
      .filter((_, i) => i % Math.floor(allCorpusFiles.length / 50) === 0)
      .slice(0, 50)
    const before = statSample.map((f) => {
      const s = fs.statSync(f)
      return { f, size: s.size, mtimeMs: s.mtimeMs }
    })

    const expectedGroups = db
      .prepare(
        `SELECT folder_id AS folderId, COUNT(*) AS n FROM photos
         WHERE status = 'folder' AND batch_id = ? GROUP BY folder_id`
      )
      .all(batchId) as { folderId: number; n: number }[]
    const expectedCopied = expectedGroups.reduce((sum, g) => sum + g.n, 0)

    const t0 = performance.now()
    const result = await exportBatch(db, batchId, exportDir)
    // eslint-disable-next-line no-console
    console.log(
      `[smoke] exportBatch copied ${result.copied} files in ${round1(performance.now() - t0)}ms`
    )

    expect(result.failures).toEqual([])
    expect(result.copied).toBe(expectedCopied)

    const subdirs = fs
      .readdirSync(exportDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
    expect(subdirs).toHaveLength(expectedGroups.length)
    const namesById = new Map(
      listFolders(db, batchId).map((f) => [f.id, f.name] as const)
    )
    for (const group of expectedGroups) {
      const dir = path.join(exportDir, namesById.get(group.folderId)!)
      expect(fs.readdirSync(dir)).toHaveLength(group.n)
    }

    const exportedNames = new Set(walkFiles(exportDir, false).map((f) => path.basename(f)))
    for (const name of trashedNames) expect(exportedNames.has(name)).toBe(false)

    // Source corpus: sampled size/mtime unchanged and the full file set identical.
    for (const b of before) {
      const s = fs.statSync(b.f)
      expect(s.size).toBe(b.size)
      expect(s.mtimeMs).toBe(b.mtimeMs)
    }
    expect(walkFiles(CORPUS, false).sort()).toEqual(allCorpusFiles)
  })
})
