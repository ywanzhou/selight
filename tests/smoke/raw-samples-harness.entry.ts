// Committed Electron smoke harness for the real-sample closed loop. Bundled
// by electron-vite into out/main/raw-harness.js and launched through
// tests/smoke/electron-raw-samples-harness.cjs (which also verifies process-tree
// cleanup with taskkill /T + a WMI zero-remainder check).
//
// It drives the REAL production modules inside Electron:
//   scanDirectory/importScanned -> ensureRawPreview -> ensureThumbnail(sharp)
//   -> selight://thumb/<id> and selight://photo/<id> protocol routes.
// Frame dimensions come from sharp metadata, so every orientation assertion
// below is a real decoded-frame check, not a byte check.
//
// Enable exactly like tests/smoke/raw-samples.test.ts: drop 3-5 real files into
// <repo>/samples/ (gitignored), incl. a vertical ARW with source EXIF 6/8 and a
// normal JPG. Without samples/ the harness prints {"skipped": true} and exits 0.
// Exit code 1 means the production RAW/orientation pipeline is broken on real files.
import { app, net } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { importScanned, scanDirectory } from '../../electron/scanner'
import {
  ensureThumbnail,
  PLACEHOLDER_JPEG_BYTES,
  type ThumbnailPhoto
} from '../../electron/media/thumbnails'
import { registerMediaProtocol } from '../../electron/media/protocol'
import { RAW_EXTENSIONS } from '../../electron/media/formats'

const SAMPLES = path.resolve(__dirname, '..', '..', 'samples')
const DIRECT_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

function walkSupported(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkSupported(abs))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (RAW_EXTENSIONS.has(ext) || DIRECT_EXT.has(ext)) out.push(abs)
    }
  }
  return out.sort()
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

async function jpegSize(bytes: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}

function expectVertical(orientation: number): boolean {
  return orientation === 6 || orientation === 8
}

app.whenReady().then(async () => {
  const tempDirs: string[] = []
  let db: Database | null = null
  const failures: string[] = []
  const fail = (message: string): void => {
    failures.push(message)
  }

  try {
    const sampleFiles = fs.existsSync(SAMPLES) ? walkSupported(SAMPLES) : []
    if (!fs.existsSync(SAMPLES) || sampleFiles.length === 0) {
      console.log(
        JSON.stringify({
          skipped: true,
          reason: `samples/ missing or empty at ${SAMPLES}; drop 3-5 real files incl. vertical ARW (EXIF 6/8) and a normal JPG`
        })
      )
      app.exit(0)
      return
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-raw-harness-'))
    tempDirs.push(root)
    const thumbDir = path.join(root, 'thumbnails')
    const previewDir = path.join(root, 'previews')
    fs.mkdirSync(thumbDir)
    fs.mkdirSync(previewDir)

    db = openDatabase(path.join(root, 'samples-harness.db')).db
    const batchId = createBatch(db, 'raw samples harness').id
    const sourceId = Number(
      db
        .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
        .run(batchId, SAMPLES).lastInsertRowid
    )

    const scan = await scanDirectory(SAMPLES)
    if (scan.failures.length !== 0) fail(`scan failures: ${scan.failures.join('; ')}`)
    const imported = importScanned(db, batchId, sourceId, scan.files)
    if (imported.added !== sampleFiles.length) {
      fail(`imported ${imported.added} rows but disk holds ${sampleFiles.length} files`)
    }

    // Same registration production main.ts uses; routes resolve against the temp
    // roots and this harness DB only. The harness pre-generates every thumbnail,
    // so the 404 enqueue seam can stay a no-op.
    registerMediaProtocol(db, { thumbDir, previewDir }, () => undefined)

    const rows = db
      .prepare(
        'SELECT id, abs_path AS absPath, ext, orientation, missing FROM photos ORDER BY id'
      )
      .all() as ThumbnailPhoto[]

    const files: Array<Record<string, unknown>> = []
    for (const photo of rows) {
      const ext = photo.ext.toLowerCase()
      const isRaw = RAW_EXTENSIONS.has(ext)
      const verticalExpected = expectVertical(photo.orientation)
      const record: Record<string, unknown> = {
        file: path.relative(SAMPLES, photo.absPath),
        ext,
        orientation: photo.orientation,
        verticalExpected
      }

      // ----------------------------------------------------- production thumbnail
      const result = await ensureThumbnail(photo, thumbDir, { previewDir })
      const thumbFile = path.join(thumbDir, `${photo.id}.jpg`)
      const sidecar = `${thumbFile}.placeholder`
      record.placeholder = result.placeholder
      if (result.placeholder) fail(`${photo.absPath}: ensureThumbnail returned placeholder`)
      if (fs.existsSync(sidecar)) fail(`${photo.absPath}: unexpected placeholder sidecar`)
      if (!fs.existsSync(thumbFile)) {
        fail(`${photo.absPath}: thumbnail file missing`)
        files.push(record)
        continue
      }
      const thumbBytes = fs.readFileSync(thumbFile)
      if (!isJpeg(thumbBytes)) fail(`${photo.absPath}: thumbnail missing JPEG SOI`)
      if (Buffer.compare(thumbBytes, PLACEHOLDER_JPEG_BYTES) === 0) {
        fail(`${photo.absPath}: thumbnail bytes equal the placeholder constant`)
      }
      const thumbDims = await jpegSize(thumbBytes)
      record.thumb = { width: thumbDims.width, height: thumbDims.height }
      if (thumbDims.width === 0 || thumbDims.height === 0) {
        fail(`${photo.absPath}: sharp decoded an empty thumbnail`)
      }
      if (verticalExpected && thumbDims.width >= thumbDims.height) {
        fail(
          `${photo.absPath}: orientation ${photo.orientation} thumbnail is not vertical ` +
            `(${thumbDims.width}x${thumbDims.height})`
        )
      }

      // -------------------------------------------------- selight://thumb/<id> route
      const thumbRes = await net.fetch(`selight://thumb/${photo.id}`)
      if (!thumbRes.ok) {
        fail(`${photo.absPath}: selight://thumb/${photo.id} -> HTTP ${thumbRes.status}`)
      } else {
        const routed = Buffer.from(await thumbRes.arrayBuffer())
        if (!isJpeg(routed)) fail(`${photo.absPath}: thumb route returned non-JPEG bytes`)
        const routedDims = await jpegSize(routed)
        record.thumbRoute = { width: routedDims.width, height: routedDims.height }
        if (routedDims.width !== thumbDims.width || routedDims.height !== thumbDims.height) {
          fail(
            `${photo.absPath}: thumb route dims ${routedDims.width}x${routedDims.height} ` +
              `disagree with cache ${thumbDims.width}x${thumbDims.height}`
          )
        }
      }

      // -------------------------------------------------- selight://photo/<id> route
      const photoRes = await net.fetch(`selight://photo/${photo.id}`)
      if (!photoRes.ok) {
        fail(`${photo.absPath}: selight://photo/${photo.id} -> HTTP ${photoRes.status}`)
      } else {
        const routed = Buffer.from(await photoRes.arrayBuffer())
        if (isRaw) {
          // RAW is never served directly: only the extracted, rotated preview cache.
          if (!isJpeg(routed)) fail(`${photo.absPath}: photo route returned non-JPEG preview`)
          const previewDims = await jpegSize(routed)
          record.photoRoute = { width: previewDims.width, height: previewDims.height }
          if (verticalExpected && previewDims.width >= previewDims.height) {
            fail(
              `${photo.absPath}: orientation ${photo.orientation} photo-route preview is not vertical ` +
                `(${previewDims.width}x${previewDims.height})`
            )
          }
          // Both routes must display the same orientation: their aspect classes agree.
          const previewVertical = previewDims.width < previewDims.height
          const thumbVertical = thumbDims.width < thumbDims.height
          if (previewVertical !== thumbVertical) {
            fail(`${photo.absPath}: thumb and photo routes disagree on orientation`)
          }
        } else {
          // Direct-read formats: the route must serve the untouched source bytes, so
          // any EXIF orientation tag survives for Chromium / system viewers to honor.
          const sourceBytes = fs.readFileSync(photo.absPath)
          record.photoRoute = { bytesEqualSource: Buffer.compare(routed, sourceBytes) === 0 }
          if (Buffer.compare(routed, sourceBytes) !== 0) {
            fail(`${photo.absPath}: photo route did not serve the original source bytes`)
          }
          if (ext === '.jpg' || ext === '.jpeg') {
            // The thumbnail physically applied the same EXIF orientation the system
            // viewer applies to the source the photo route serves: no route disagreement.
            if (verticalExpected && thumbDims.width >= thumbDims.height) {
              fail(`${photo.absPath}: JPG thumbnail did not honor EXIF ${photo.orientation}`)
            }
          }
        }
      }
      files.push(record)
    }

    const verticalArw = rows.filter(
      (r) =>
        RAW_EXTENSIONS.has(r.ext.toLowerCase()) &&
        (r.orientation === 6 || r.orientation === 8)
    )
    if (verticalArw.length === 0) {
      fail('samples/ contains no vertical RAW (source EXIF Orientation 6 or 8)')
    }

    console.log(
      JSON.stringify({
        ok: failures.length === 0,
        electron: process.versions.electron,
        chromium: process.versions.chromium,
        samples: sampleFiles.length,
        verticalRaw: verticalArw.length,
        failures,
        files
      })
    )
    await exiftool.end()
    if (db.open) db.close()
    app.exit(failures.length === 0 ? 0 : 1)
  } catch (err) {
    console.error(JSON.stringify({ ok: false, fatal: String((err as Error)?.message ?? err) }))
    try {
      await exiftool.end()
    } catch {
      // Shutdown best effort.
    }
    if (db?.open) db.close()
    app.exit(1)
  } finally {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  }
})
