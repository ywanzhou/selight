import { contextBridge } from 'electron'

const api = {
  platform: process.platform
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore declared in preload.d.ts
  window.api = api
}
