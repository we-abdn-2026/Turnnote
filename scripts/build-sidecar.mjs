import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const localExecutable = resolve(
  process.platform === 'win32' ? '.venv/Scripts/pyinstaller.exe' : '.venv/bin/pyinstaller',
);
const executable =
  process.env.PYINSTALLER ??
  (existsSync(localExecutable)
    ? localExecutable
    : process.platform === 'win32'
      ? 'pyinstaller.exe'
      : 'pyinstaller');

const result = spawnSync(
  executable,
  [
    '--noconfirm',
    '--clean',
    '--onedir',
    '--name',
    'asr-worker',
    '--distpath',
    'build/sidecar',
    '--workpath',
    'build/pyinstaller',
    '--specpath',
    'build/pyinstaller',
    'services/asr-worker/worker.py',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PYINSTALLER_CONFIG_DIR: resolve('build/pyinstaller-cache'),
    },
  },
);

if (result.error) {
  console.error(`PyInstaller could not start: ${result.error.message}`);
  console.error('Install requirements-dev.txt or create the project .venv first.');
}
process.exit(result.status ?? 1);
