import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/main.ts'),
          // Committed Electron smoke harness for the sharp media pipeline; run via
          // tests/smoke/electron-media-harness.cjs after `npm run build`.
          'media-harness': resolve('tests/smoke/media-harness.entry.ts'),
          // Task 19 real-sample RAW/orientation harness; run via
          // tests/smoke/electron-raw-samples-harness.cjs after `npm run build`.
          'raw-harness': resolve('tests/smoke/raw-samples-harness.entry.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve('src'),
    server: {
      port: 6677
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
