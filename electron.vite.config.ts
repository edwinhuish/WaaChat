import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// Three independent bundles. Keeping them explicit (rather than relying on
// conventions) means a new top-level source directory can never silently end up
// in the wrong bundle.
export default defineConfig({
  main: {
    build: {
      outDir: resolve(__dirname, 'out/main'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(__dirname, 'out/preload'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
