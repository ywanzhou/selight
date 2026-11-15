import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/main.ts'),
          // Committed Electron smoke harness for the Blink webp pipeline; run via
          // tests/smoke/electron-blink-harness.cjs after `npm run build`.
          harness: resolve('tests/smoke/blink-harness.entry.ts')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/preload.ts'),
          helper: resolve('electron/helper-preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve('src'),
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/index.html'),
          helper: resolve('src/helper.html')
        }
      }
    },
    plugins: [react()]
  }
})
