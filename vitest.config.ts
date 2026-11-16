const { defineConfig } = require('vitest/config')

// CommonJS syntax keeps Vite 8's native config loader silent while
// package.json has no "type": "module" (main process stays CJS for native addons).
module.exports = defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
