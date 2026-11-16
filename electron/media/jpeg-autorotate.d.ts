// jpeg-autorotate v9 ships no TypeScript types. The public rotate() reads the
// JPEG's own EXIF orientation (and throws when absent), so we use the lower
// level transform export that takes the EXIF orientation value explicitly.
declare module 'jpeg-autorotate/src/transform' {
  export function rotateBuffer(
    buffer: Buffer,
    orientation: number,
    quality: number,
    maxResolutionInMP?: number | null,
    maxMemoryUsageInMB?: number | null
  ): Promise<{ buffer: Buffer; width: number; height: number }>
}
