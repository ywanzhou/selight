// Committed Electron smoke harness for the sharp media pipeline. Bundled by
// electron-vite into out/main/media-harness.js and launched through
// tests/smoke/electron-media-harness.cjs (which also verifies process-tree
// cleanup with taskkill /T + a WMI zero-remainder check).
//
// It drives the REAL production modules end to end:
//   ensureThumbnail -> sharp(libvips) decode/rotate/resize -> width-320 JPEG
// The corpus is opened read-only; every DB and cache file lands in a temp
// dir removed before exit. Exit code 1 means production thumbnails are not
// real sharp output.
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import sharp from 'sharp'
import { openDatabase } from '../../electron/db/schema'
import {
  createThumbnailQueue,
  ensureThumbnail,
  PLACEHOLDER_JPEG_BYTES,
  type ThumbnailPhoto
} from '../../electron/media/thumbnails'
import { ExiftoolReader } from '../../electron/media/rawPreview'
import { exiftool } from 'exiftool-vendored'

const CORPUS = path.resolve(__dirname, '..', '..', '素材')
const SAMPLES = path.resolve(__dirname, '..', '..', 'samples')
const SAMPLE_SIZE = 20

function walkWebp(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkWebp(abs))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.webp')) out.push(abs)
  }
  return out.sort()
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(abs))
    else if (entry.isFile()) out.push(abs)
  }
  return out.sort()
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
}

function insertPhoto(
  db: Database,
  batchId: number,
  sourceId: number,
  absPath: string,
  ext: string
): number {
  const info = db
    .prepare(
      `INSERT INTO photos
         (batch_id, source_id, abs_path, filename, ext, size_bytes, mtime, orientation, status, missing)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1, 'inbox', 0)`
    )
    .run(batchId, sourceId, absPath, path.basename(absPath), ext)
  return Number(info.lastInsertRowid)
}

app.whenReady().then(async () => {
  const tempDirs: string[] = []
  let db: Database | null = null
  const failures: string[] = []
  const fail = (message: string): void => {
    failures.push(message)
  }

  try {
    if (!fs.existsSync(CORPUS)) {
      console.log(JSON.stringify({ skipped: true, reason: `corpus missing: ${CORPUS}` }))
      app.exit(0)
      return
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-media-harness-'))
    tempDirs.push(root)
    const thumbDir = path.join(root, 'thumbnails')
    const previewDir = path.join(root, 'previews')
    fs.mkdirSync(thumbDir)
    fs.mkdirSync(previewDir)

    // ------------------------------------------------------------- sharp control
    // Prove libvips itself can encode a JPEG inside the Electron process.
    const controlJpg = path.join(root, 'control.jpg')
    fs.writeFileSync(
      controlJpg,
      await sharp({
        create: { width: 8, height: 4, channels: 3, background: { r: 200, g: 100, b: 50 } }
      })
        .jpeg()
        .toBuffer()
    )
    const controlMeta = await sharp(controlJpg).metadata()
    const sharpControl = { ok: controlMeta.width === 8 && controlMeta.height === 4 }
    if (!sharpControl.ok) fail('sharp JPEG control failed')

    // ------------------------------------------------------------- DB + samples
    db = openDatabase(path.join(root, 'harness.db')).db
    const batchId = Number(
      db.prepare('INSERT INTO batches (name) VALUES (?)').run('harness').lastInsertRowid
    )
    const sourceId = Number(
      db
        .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
        .run(batchId, CORPUS).lastInsertRowid
    )

    const allWebp = walkWebp(CORPUS)
    const stride = Math.floor(allWebp.length / SAMPLE_SIZE)
    const sample = allWebp.filter((_, i) => i % stride === 0).slice(0, SAMPLE_SIZE)

    const rows: ThumbnailPhoto[] = sample.map((absPath) => ({
      id: insertPhoto(db!, batchId, sourceId, absPath, '.webp'),
      absPath,
      ext: '.webp',
      orientation: 1,
      width: null,
      missing: 0
    }))

    app.on('window-all-closed', () => {})

    // --------------------------------------------- 20 real webp through sharp
    const files: Array<Record<string, unknown>> = []
    const durations: number[] = []
    for (const photo of rows) {
      const t0 = performance.now()
      const result = await ensureThumbnail(photo, thumbDir, { previewDir })
      durations.push(performance.now() - t0)
      const file = path.join(thumbDir, `${photo.id}.jpg`)
      const sidecar = `${file}.placeholder`
      const record: Record<string, unknown> = {
        source: path.relative(CORPUS, photo.absPath),
        placeholder: result.placeholder
      }
      if (!fs.existsSync(file)) {
        fail(`thumbnail missing for photo ${photo.id}`)
        files.push(record)
        continue
      }
      const bytes = fs.readFileSync(file)
      const soi = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      const hasSidecar = fs.existsSync(sidecar)
      const isPlaceholderBytes = Buffer.compare(bytes, PLACEHOLDER_JPEG_BYTES) === 0
      const dims = await sharp(file).metadata()
      Object.assign(record, {
        bytes: bytes.length,
        soi,
        sidecar: hasSidecar,
        placeholderBytes: isPlaceholderBytes,
        width: dims.width,
        height: dims.height
      })
      if (result.placeholder) fail(`photo ${photo.id}: ensureThumbnail reported placeholder`)
      if (!soi) fail(`photo ${photo.id}: missing JPEG SOI marker`)
      if (hasSidecar) fail(`photo ${photo.id}: unexpected placeholder sidecar`)
      if (isPlaceholderBytes) fail(`photo ${photo.id}: bytes equal the placeholder constant`)
      // fit-inside 320: the LONG edge is 320 for both landscape and portrait shots.
      const longEdge = Math.max(dims.width ?? 0, dims.height ?? 0)
      const shortEdge = Math.min(dims.width ?? 0, dims.height ?? 0)
      if (longEdge !== 320 || shortEdge > 320) {
        fail(`photo ${photo.id}: thumbnail ${dims.width}x${dims.height} is not fit-inside 320`)
      }
      files.push(record)
    }

    // ---------------------------------------------------------- fallback control
    const ghostId = insertPhoto(
      db,
      batchId,
      sourceId,
      path.join(root, 'vanished.webp'),
      '.webp'
    )
    const ghostResult = await ensureThumbnail(
      {
        id: ghostId,
        absPath: path.join(root, 'vanished.webp'),
        ext: '.webp',
        orientation: 1,
        width: null,
        missing: 0
      },
      thumbDir,
      { previewDir }
    )
    const ghostFile = path.join(thumbDir, `${ghostId}.jpg`)
    const ghostOk =
      ghostResult.placeholder === true &&
      fs.existsSync(`${ghostFile}.placeholder`) &&
      Buffer.compare(fs.readFileSync(ghostFile), PLACEHOLDER_JPEG_BYTES) === 0
    if (!ghostOk) fail('missing-source webp did not degrade to the placeholder + sidecar')

    // --------------------------------------------- RAW self-heal (samples only)
    let rawSelfHeal: Record<string, unknown> | null = null
    const sampleArw = fs.existsSync(SAMPLES)
      ? walkFiles(SAMPLES).find((f) => f.toLowerCase().endsWith('.arw'))
      : undefined
    if (sampleArw) {
      const rawId = insertPhoto(db, batchId, sourceId, sampleArw, '.arw')
      const before = db
        .prepare('SELECT width FROM photos WHERE id = ?')
        .get(rawId) as { width: number | null }
      const ready: Array<[number, boolean]> = []
      const queue = createThumbnailQueue(
        db,
        { thumbDir, previewDir },
        new ExiftoolReader(),
        (id, ok) => ready.push([id, ok])
      )
      await new Promise<void>((resolve) => {
        queue.onIdle(resolve)
        queue.enqueue([rawId])
      })
      queue.stop()
      const after = db
        .prepare('SELECT orientation, width, height FROM photos WHERE id = ?')
        .get(rawId) as { orientation: number; width: number | null; height: number | null }
      rawSelfHeal = {
        startedUnenriched: before.width === null,
        enriched: after.width !== null,
        ready: ready.at(-1),
        vertical: after.orientation === 6 || after.orientation === 8
      }
      if (before.width !== null) fail('RAW fixture expected to start unenriched')
      if (after.width === null) fail('RAW self-heal did not fill dimensions')
      if (ready.at(-1)?.[1] !== true) fail('RAW thumbnail did not report ready ok:true')
      await exiftool.end()
    }

    const summary = {
      ok: failures.length === 0,
      electron: process.versions.electron,
      chromium: process.versions.chromium,
      corpusWebp: allWebp.length,
      sampled: sample.length,
      sharpControl,
      fallbackPlaceholder: ghostOk,
      // Read back the live setting instead of hardcoding the configured value.
      sharpConcurrency: sharp.concurrency(),
      decodeMs: {
        p50: Math.round(percentile(durations, 0.5) * 10) / 10,
        p95: Math.round(percentile(durations, 0.95) * 10) / 10,
        max: Math.round(Math.max(...durations) * 10) / 10
      },
      rss: {
        // Node reports resourceUsage().maxRSS in kilobytes across platforms.
        maxRssKb: process.resourceUsage().maxRSS,
        heapUsedBytes: process.memoryUsage().heapUsed
      },
      rawSelfHeal,
      failures,
      files
    }
    console.log(JSON.stringify(summary))
    if (db.open) db.close()
    app.exit(failures.length === 0 ? 0 : 1)
  } catch (err) {
    console.error(JSON.stringify({ ok: false, fatal: String((err as Error)?.message ?? err) }))
    if (db?.open) db.close()
    app.exit(1)
  } finally {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  }
})
