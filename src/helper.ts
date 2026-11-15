// Bundled Blink decode pipeline for the hidden helper window. The main process only
// ever sends DB-registered photo ids, and the selight://photo route re-validates the
// id against the database before serving the source file.
import {
  BLINK_JPEG_QUALITY,
  BLINK_THUMB_WIDTH,
  type BlinkDecodeRequest
} from '../electron/shared/blinkProtocol'

window.selightBlink?.onDecodeRequest(async (req: BlinkDecodeRequest): Promise<ArrayBuffer> => {
  const response = await fetch(`selight://photo/${req.photoId}`)
  if (!response.ok) {
    throw new Error(`source fetch failed: HTTP ${response.status}`)
  }
  // from-image honors EXIF orientation; Blink decodes webp where main-process
  // nativeImage cannot (Electron 44 corpus 20/20 failures).
  const bitmap = await createImageBitmap(await response.blob(), {
    imageOrientation: 'from-image'
  })
  const scale = Math.min(1, BLINK_THUMB_WIDTH / bitmap.width)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const jpeg = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: BLINK_JPEG_QUALITY
  })
  return jpeg.arrayBuffer()
})
