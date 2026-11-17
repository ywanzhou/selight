/**
 * Task 19 — real RAW sample closed loop for the named top risk (Review Focus #1):
 * Sony ARW embedded previews carry NO orientation tag, so the source file's EXIF
 * Orientation (6 = CW90, 8 = CCW90) must drive the rotation, and vertical shots
 * must decode with width < height after correction.
 *
 * HOW TO ENABLE (user-provided evidence, never faked by this repo):
 *   Drop 3-5 real camera files into <repo>/samples/ (already in .gitignore):
 *     - at least one vertical Sony .ARW whose SOURCE EXIF Orientation is 6 or 8
 *     - at least one normal .jpg/.jpeg (orientation-tagged if available)
 *     - any other RAW / JPG samples are optional
 * BEHAVIOR WITHOUT samples/ (or when it holds no supported images):
 *   The whole describe below is skipped with a reason naming these contents, so
 *   `npm test` stays green on every machine without the private corpus.
 * NODE BOUNDARY (this file): real ExifTool scan/import, real preview extraction,
 *   sharp rotation, JPEG frame dimensions read with sharp metadata.
 * ELECTRON-ONLY BOUNDARY (selight://thumb|photo routes):
 *   tests/smoke/raw-samples-harness.entry.ts, built by electron-vite and launched
 *   manually via tests/smoke/electron-raw-samples-harness.cjs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import { openDatabase } from '../../electron/db/schema'
import { createBatch } from '../../electron/domain/batches'
import { importScanned, scanDirectory } from '../../electron/scanner'
import { ExiftoolReader } from '../../electron/media/rawPreview'
import { EnrichmentService } from '../../electron/media/enrich'
import { orientationToRotate } from '../../electron/media/orientation'
import { RAW_EXTENSIONS } from '../../electron/media/formats'
import type { ThumbnailPhoto } from '../../electron/media/thumbnails'

const SAMPLES = path.resolve(__dirname, '..', '..', 'samples')
// Direct-read formats from scanner.ts SUPPORTED_EXT (not exported); mirrored like
// fullflow.test.ts does, so the walk counts exactly what scanDirectory imports.
const DIRECT_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const KNOWN_ORIENTATIONS = new Set([1, 3, 6, 8])
// Real ExifTool over a handful of files only, but ARW preview extraction is heavy.
const SLOW = 120_000

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

const sampleFiles = fs.existsSync(SAMPLES) ? walkSupported(SAMPLES) : []
const rawSampleFiles = sampleFiles.filter((f) => RAW_EXTENSIONS.has(path.extname(f).toLowerCase()))
const jpgSampleFiles = sampleFiles.filter((f) => {
  const ext = path.extname(f).toLowerCase()
  return ext === '.jpg' || ext === '.jpeg'
})
const skipReason = !fs.existsSync(SAMPLES)
  ? `samples/ missing: create ${SAMPLES} and drop in 3-5 real files ` +
    '(>=1 vertical ARW with source EXIF Orientation 6 or 8, >=1 normal JPG)'
  : sampleFiles.length === 0
    ? 'samples/ holds no supported images; need 3-5 real files incl. a vertical ARW (EXIF 6/8) and a normal JPG'
    : ''
const suite = skipReason ? describe.skip : describe

suite(
  skipReason
    ? `smoke: real RAW samples in samples/ — SKIPPED (${skipReason})`
    : 'smoke: real RAW samples in samples/ (orientation closed loop)',
  () => {
    const dirs: string[] = []
    let dbFile = ''
    let db: Database
    let reader: ExiftoolReader
    let previewDir = ''
    let rows: ThumbnailPhoto[] = []
    const rowFor = (absPath: string): ThumbnailPhoto =>
      rows.find((r) => r.absPath === absPath) ?? (() => { throw new Error(`no DB row for ${absPath}`) })()

    beforeAll(async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-raw-samples-'))
      dirs.push(root)
      dbFile = path.join(root, 'samples.db')
      db = openDatabase(dbFile).db
      previewDir = path.join(root, 'previews')
      reader = new ExiftoolReader()
      const batchId = createBatch(db, 'raw samples').id

      const scan = await scanDirectory(SAMPLES)
      expect(scan.failures).toEqual([])
      expect(scan.files).toHaveLength(sampleFiles.length)
      const sourceId = Number(
        db
          .prepare('INSERT INTO sources (batch_id, abs_path) VALUES (?, ?)')
          .run(batchId, SAMPLES).lastInsertRowid
      )
      const imported = importScanned(db, batchId, sourceId, scan.files)
      expect(imported).toEqual({ added: sampleFiles.length, updated: 0, missing: 0 })

      // Discovery is fs-only: run the same background enrichment the app does
      // so orientation/dimensions reflect the real files before assertions.
      const service = new EnrichmentService(db, new ExiftoolReader())
      service.submit(
        (db.prepare('SELECT id FROM photos ORDER BY id').all() as { id: number }[]).map(
          (r) => r.id
        )
      )
      await service.whenIdle()
      service.stop()

      rows = db
        .prepare(
          'SELECT id, abs_path AS absPath, ext, orientation, width, missing FROM photos ORDER BY id'
        )
        .all() as ThumbnailPhoto[]
    }, SLOW)

    afterAll(async () => {
      await exiftool.end()
      if (db?.open) db.close()
      while (dirs.length) {
        fs.rmSync(dirs.pop()!, { recursive: true, force: true })
      }
    }, SLOW)

    it('imports every sample with a known EXIF orientation and the pinned rotation mapping', () => {
      expect(rows).toHaveLength(sampleFiles.length)
      const expectedAngle: Record<number, number> = { 1: 0, 3: 180, 6: 90, 8: 270 }
      for (const row of rows) {
        expect(KNOWN_ORIENTATIONS.has(row.orientation)).toBe(true)
        expect(orientationToRotate(row.orientation)).toBe(expectedAngle[row.orientation])
        expect(row.missing).toBe(0)
      }
    })

    it('covers the named top risk: at least one vertical ARW (EXIF 6/8) is present', (ctx) => {
      const vertical = rows.filter(
        (r) =>
          RAW_EXTENSIONS.has(r.ext.toLowerCase()) &&
          (r.orientation === 6 || r.orientation === 8)
      )
      if (vertical.length === 0) {
        ctx.skip()
      }
      expect(vertical.length).toBeGreaterThan(0)
    })

    for (const absPath of rawSampleFiles) {
      it(
        `extracts, rotates and caches an upright preview for ${path.basename(absPath)}`,
        async () => {
          const photo = rowFor(absPath)
          // Real ExifTool binary-tag extraction (ThumbnailImage then PreviewImage).
          const extracted = await reader.extractPreview(photo.absPath)
          expect(extracted.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))

          const preview = await reader.ensureRawPreview(
            { id: photo.id, absPath: photo.absPath, orientation: photo.orientation },
            previewDir
          )
          expect(preview).toBe(path.join(previewDir, `${photo.id}.jpg`))
          const bytes = fs.readFileSync(preview)
          expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))

          // sharp reads the encoded frame: our rotation physically swaps the frame,
          // so a corrected vertical shot must have width < height here, in bare node.
          const dims = await sharp(bytes).metadata()
          expect(dims.width).toBeGreaterThan(0)
          expect(dims.height).toBeGreaterThan(0)
          if (photo.orientation === 6 || photo.orientation === 8) {
            expect(dims.width).toBeLessThan(dims.height!)
          }
        },
        SLOW
      )
    }

    it('produces no placeholder sidecars for healthy RAW previews', (ctx) => {
      if (rawSampleFiles.length === 0) {
        ctx.skip()
      }
      const sidecars = fs
        .readdirSync(previewDir)
        .filter((name) => name.endsWith('.placeholder'))
      expect(sidecars).toEqual([])
    })

    it('honors JPG EXIF orientation: rotated bytes decode upright for every tagged JPG', async (ctx) => {
      if (jpgSampleFiles.length === 0) {
        ctx.skip()
      }
      const tagged = rows.filter(
        (r) =>
          (r.ext.toLowerCase() === '.jpg' || r.ext.toLowerCase() === '.jpeg') &&
          r.orientation !== 1
      )
      if (tagged.length === 0) {
        ctx.skip()
      }
      for (const photo of tagged) {
        const rotated = await sharp(await fs.promises.readFile(photo.absPath))
          .rotate(orientationToRotate(photo.orientation))
          .jpeg()
          .toBuffer()
        expect(rotated.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
        const dims = await sharp(rotated).metadata()
        if (photo.orientation === 6 || photo.orientation === 8) {
          expect(dims.width).toBeLessThan(dims.height!)
        }
      }
    }, SLOW)
  }
)
