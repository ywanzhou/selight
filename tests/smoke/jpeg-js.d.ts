// jpeg-js ships only as CommonJS with no bundled types. It is already present in
// node_modules as a transitive dependency of jpeg-autorotate (used in production),
// and the T18/T18.5 smoke harnesses use it to generate control JPEGs on disk.
declare module 'jpeg-js' {
  export interface JpegImageData {
    data: Buffer
    width: number
    height: number
  }
  export function encode(
    image: { data: Buffer | Uint8Array; width: number; height: number },
    quality?: number
  ): JpegImageData
  export function decode(
    jpegData: Buffer | Uint8Array,
    options?: {
      maxMemoryUsageInMB?: number
      formatAsRGBA?: boolean
      tolerant?: boolean
    }
  ): JpegImageData
}
