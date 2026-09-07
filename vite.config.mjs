import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'

// 用 .mjs 后缀，保证 Vite 以 ESM 加载配置；
// package.json 不声明 "type":"module"，因此构建出的主进程/preload 为 CJS，Electron 可直接加载。
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.js',
        vite: {
          build: {
            rolldownOptions: {
              external: ['koffi', /@koromix/], // koffi 含原生 .node，由运行时按需加载
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.js',
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        capture: resolve(__dirname, 'capture.html'),
      },
    },
  },
})
