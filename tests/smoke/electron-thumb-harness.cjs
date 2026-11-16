// Electron-side companion of fullflow.test.ts. Vitest under bare Node cannot load
// electron's nativeImage (Ruling 2), so real decoding is proven here:
//
//   npx electron tests/smoke/electron-thumb-harness.cjs
//
// It samples 20 real .webp files from the corpus and exercises the exact nativeImage
// call ensureThumbnail uses on Windows (createThumbnailFromPath), plus the
// Chromium-decoder entry point and a JPEG control. The corpus is opened read-only;
// every written byte lands in a temp cache dir that is removed before exit.
// Exit code 1 means the production thumbnail path cannot decode the corpus: the
// node suite's mocked-nativeImage tests cannot catch that, so treat this as a smoke
// alarm and check the JSON before assuming real thumbnails are being produced.
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const jpeg = require('jpeg-js')

const CORPUS = path.resolve(__dirname, '..', '..', '素材')
const THUMB_WIDTH = 320
const JPEG_QUALITY = 85

function walkWebp(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkWebp(abs))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.webp')) out.push(abs)
  }
  return out.sort()
}

app.whenReady().then(async () => {
  let cacheDir
  try {
    if (!fs.existsSync(CORPUS)) {
      console.log(JSON.stringify({ skipped: true, reason: `corpus missing: ${CORPUS}` }))
      app.exit(0)
      return
    }

    // Control: JPEG must decode in the same runtime before anything webp is judged.
    const frame = Buffer.alloc(4 * 8 * 4)
    for (let i = 0; i < frame.length; i += 4) frame.set([200, 100, 50, 255], i)
    const jpg = jpeg.encode({ data: frame, width: 8, height: 4 }, 90).data
    const jpegControl = nativeImage.createFromBuffer(jpg)
    if (jpegControl.isEmpty()) throw new Error('JPEG control failed: nativeImage decodes nothing')

    const all = walkWebp(CORPUS)
    const stride = Math.floor(all.length / 20)
    const sample = all.filter((_, i) => i % stride === 0).slice(0, 20)
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selight-harness-'))

    const files = []
    let productionFailures = 0
    for (const source of sample) {
      const row = { source: path.relative(CORPUS, source) }
      try {
        const image = await nativeImage.createThumbnailFromPath(source, {
          width: THUMB_WIDTH,
          height: THUMB_WIDTH
        })
        row.shellThumbnail = { ok: !image.isEmpty(), size: image.getSize() }
      } catch (err) {
        row.shellThumbnail = { ok: false, error: String(err.message) }
      }
      if (!row.shellThumbnail.ok) productionFailures += 1

      // Chromium-decoder boundary used by the non-Windows / fallback branches.
      const decoded = nativeImage.createFromBuffer(fs.readFileSync(source))
      row.chromiumBuffer = { ok: !decoded.isEmpty(), size: decoded.getSize() }
      if (!decoded.isEmpty()) {
        const out = path.join(cacheDir, `${files.length}.jpg`)
        fs.writeFileSync(out, decoded.resize({ width: THUMB_WIDTH }).toJPEG(JPEG_QUALITY))
        const bytes = fs.readFileSync(out)
        row.jpeg = {
          bytes: bytes.length,
          soi: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        }
      }
      files.push(row)
    }

    const result = {
      ok: productionFailures === 0,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      jpegControl: { ok: true, size: jpegControl.getSize() },
      sampled: sample.length,
      corpusWebp: all.length,
      productionFailures,
      files
    }
    console.log(JSON.stringify(result))
    app.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error(JSON.stringify({ ok: false, fatal: String(err && err.message) }))
    app.exit(1)
  } finally {
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})
