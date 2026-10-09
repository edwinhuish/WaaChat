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
      // 两个入口 = 两扇窗口（文件列表 / 设置，见 ADR-0025）。必须显式写出来：漏掉一个
      // **不会报错**，只在那扇窗口打开时白屏 —— 因此 test/e2e 对两个 HTML 都做断言。
      rollupOptions: {
        input: {
          files: resolve(__dirname, 'src/renderer/files.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
        },
      },
    },
  },
})
