import { describe, expect, it } from 'vitest'
import { orientDimensions, orientationToRotate } from '../../electron/media/orientation'

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

describe('orientDimensions', () => {
  // Stored pixel dimensions come from the file; the MetaBar must show the
  // display-state size, so 90/270-degree orientations swap width and height.
  const cases: Array<[number, number, number, number, number]> = [
    // orientation, storedW, storedH, expectedW, expectedH
    [1, 3000, 2000, 3000, 2000],
    [3, 3000, 2000, 3000, 2000],
    [6, 3000, 2000, 2000, 3000],
    [8, 3000, 2000, 2000, 3000],
    [0, 3000, 2000, 3000, 2000],
    [9, 3000, 2000, 3000, 2000]
  ]
  for (const [orientation, w, h, ew, eh] of cases) {
    it(`returns ${ew}x${eh} for stored ${w}x${h} under orientation ${orientation}`, () => {
      expect(orientDimensions(orientation, w, h)).toEqual({ width: ew, height: eh })
    })
  }
})
