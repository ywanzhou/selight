import { rotateBuffer } from 'jpeg-autorotate/src/transform'

const ROTATE_BY_ORIENTATION: Record<number, 0 | 90 | 180 | 270> = {
  1: 0,
  3: 180,
  6: 90,
  8: 270
}

export function orientationToRotate(orientation: number): 0 | 90 | 180 | 270 {
  return ROTATE_BY_ORIENTATION[orientation] ?? 0
}

// RAW embedded previews carry no EXIF orientation tag: the source ARW's
// orientation drives an external rotation here. rotateBuffer speaks EXIF
// orientation values (3/6/8) directly, not degrees.
export async function rotateJpegBuffer(buf: Buffer, orientation: number): Promise<Buffer> {
  if (orientationToRotate(orientation) === 0) return buf
  const { buffer } = await rotateBuffer(buf, orientation, 100)
  return buffer
}
