const ROTATE_BY_ORIENTATION: Record<number, 0 | 90 | 180 | 270> = {
  1: 0,
  3: 180,
  6: 90,
  8: 270
}

export function orientationToRotate(orientation: number): 0 | 90 | 180 | 270 {
  return ROTATE_BY_ORIENTATION[orientation] ?? 0
}

// sharp/exiftool report stored pixel dimensions; the UI shows display-state
// dimensions, so 90/270-degree orientations must swap the two axes.
export function orientDimensions(
  orientation: number,
  width: number,
  height: number
): { width: number; height: number } {
  return orientation === 6 || orientation === 8
    ? { width: height, height: width }
    : { width, height }
}
