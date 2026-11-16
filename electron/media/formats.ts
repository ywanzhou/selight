// RAW container extensions from the design spec, matched case-insensitively.
// Kept in one place so the thumbnail pipeline and the media resolver cannot drift.
export const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  '.arw',
  '.cr2',
  '.cr3',
  '.nef',
  '.dng',
  '.raf',
  '.rw2',
  '.orf',
  '.pef',
  '.srw'
])
