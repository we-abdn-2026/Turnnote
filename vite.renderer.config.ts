import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { UserConfig } from 'vite';

// Renderer 的共享配置：electron-vite 和 `npm run dev:web` 共用
export const rendererConfig = {
  root: resolve('apps/desktop/renderer'),
  plugins: [react()],
  build: { rollupOptions: { input: resolve('apps/desktop/renderer/index.html') } },
  resolve: { alias: { '@shared': resolve('packages/contracts/src') } },
} satisfies UserConfig;

// `npm run dev:web`：浏览器中运行 Renderer，使用 mock API，不需要 Electron 和 Python
export default { ...rendererConfig, mode: 'mock' } satisfies UserConfig;
