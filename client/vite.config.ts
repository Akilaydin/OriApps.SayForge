/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const host = process.env.TAURI_DEV_HOST
const defaultServerUrl = process.env.SAYFORGE_DEFAULT_SERVER_URL || 'http://127.0.0.1:8000'

const tauriConf = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'src-tauri/tauri.conf.json'), 'utf-8')
)
const fakeVersion = process.env.SAYFORGE_FAKE_APP_VERSION
if (fakeVersion) {
  console.warn(`\n[vite] SAYFORGE_FAKE_APP_VERSION=${fakeVersion} — simulated version; do not use for production builds.\n`)
}
const appVersion = fakeVersion || tauriConf.version || '0.0.0'

export default defineConfig({
  define: {
    __SAYFORGE_DEFAULT_SERVER_URL__: JSON.stringify(defaultServerUrl),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    minify: 'esbuild',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
        trayMenu: path.resolve(__dirname, 'tray-menu.html'),
        updateNotification: path.resolve(__dirname, 'update-notification.html'),
      },
    },
  },
  esbuild: {
    drop: ['debugger'],
    pure: ['console.log'],
  },
})
