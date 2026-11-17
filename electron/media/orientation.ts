const ROTATE_BY_ORIENTATION: Record<number, 0 | 90 | 180 | 270> = {
  1: 0,
  3: 180,
  6: 90,
  8: 270
}

export function orientationToRotate(orientation: number): 0 | 90 | 180 | 270 {
  return ROTATE_BY_ORIENTATION[orientation] ?? 0
}
