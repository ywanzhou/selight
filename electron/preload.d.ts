import type { SelightApi } from './shared/api'

declare global {
  interface Window {
    selight: SelightApi
  }
}

export {}
