import { describe, expect, it } from 'vitest'
import { orientationToRotate } from '../../electron/media/orientation'

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
