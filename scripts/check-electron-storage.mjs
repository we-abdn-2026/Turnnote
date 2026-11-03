import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildRuntime } from '../tests/support/build-runtime.mjs';

await buildRuntime();
const electronPath = createRequire(import.meta.url)('electron');
const result = spawnSync(electronPath, ['tests/support/electron-storage-smoke.mjs'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
if (result.error)
  console.error('Electron storage smoke could not start. Install the Electron binary first.');
process.exit(result.status ?? 1);
