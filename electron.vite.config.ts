import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('apps/desktop/main/index.ts') } },
    resolve: { alias: { '@shared': resolve('packages/contracts/src') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('apps/desktop/preload/index.ts') } },
    resolve: { alias: { '@shared': resolve('packages/contracts/src') } },
  },
  renderer: {
    root: resolve('apps/desktop/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: resolve('apps/desktop/renderer/index.html') } },
    resolve: { alias: { '@shared': resolve('packages/contracts/src') } },
  },
});
