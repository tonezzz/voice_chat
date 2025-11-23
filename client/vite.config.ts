import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message?.includes('"use client"')) {
          return
        }
        if (defaultHandler) {
          defaultHandler(warning)
        }
      }
    }
  }
})
