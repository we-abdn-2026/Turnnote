import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { rendererConfig } from './vite.renderer.config';

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
  renderer: rendererConfig,
});
