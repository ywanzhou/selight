export type PreviewState = 'loading' | 'missing' | 'failed' | 'ready'

export interface PreviewStateInput {
  /** Row flagged missing=1 in the DB (source deleted/moved). */
  missing: boolean
  /** The <img> fired onError for the current URL. */
  loadFailed: boolean
  /** The <img> fired onLoad for the current URL. */
  loaded: boolean
}

// Pure state gate for the preview pane. Missing wins over a transient load
// error so absent files always reach the explicit message; ready wins over a
// stale failure flag once a later URL loads successfully.
export function derivePreviewState(input: PreviewStateInput): PreviewState {
  if (input.missing) return 'missing'
  if (input.loaded) return 'ready'
  if (input.loadFailed) return 'failed'
  return 'loading'
}
