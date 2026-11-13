import { describe, expect, it } from 'vitest'
import { orientationToRotate, rotateJpegBuffer } from '../../electron/media/orientation'
import { tinyJpeg } from './fixtures'

describe('orientationToRotate', () => {
  // Pins 6 -> 90 CW and 8 -> 270 CW explicitly: swapping these two is the
  // named top-risk failure mode (vertical shots display mirrored sideways).
  const cases: Array<[number, 0 | 90 | 180 | 270]> = [
    [1, 0],
    [3, 180],
    [6, 90],
    [8, 270],
    [0, 0],
    [9, 0]
  ]
  for (const [orientation, angle] of cases) {
    it(`maps EXIF orientation ${orientation} to ${angle}`, () => {
      expect(orientationToRotate(orientation)).toBe(angle)
    })
  }
})

describe('rotateJpegBuffer', () => {
  const jpeg = tinyJpeg()

  it('returns the same buffer reference for orientation 1', async () => {
    await expect(rotateJpegBuffer(jpeg, 1)).resolves.toBe(jpeg)
  })

  for (const orientation of [0, 9]) {
    it(`returns the same buffer reference for unknown orientation ${orientation}`, async () => {
      await expect(rotateJpegBuffer(jpeg, orientation)).resolves.toBe(jpeg)
    })
  }

  // Full dimension/visual verification against real Sony ARW samples is
  // Task 19's job; here we only assert rotation runs and emits a valid JPEG.
  for (const orientation of [3, 6, 8]) {
    it(`rotates orientation ${orientation} into a new valid JPEG buffer`, async () => {
      const out = await rotateJpegBuffer(jpeg, orientation)
      expect(out).not.toBe(jpeg)
      expect(out.length).toBeGreaterThan(0)
      expect(out.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    })
  }
})
