import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const localExecutable = resolve(
  process.platform === 'win32' ? '.venv/Scripts/pyinstaller.exe' : '.venv/bin/pyinstaller',
);
const localPython = resolve(
  process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
);
const executable =
  process.env.PYINSTALLER ??
  (existsSync(localExecutable)
    ? localExecutable
    : process.platform === 'win32'
      ? 'pyinstaller.exe'
      : 'pyinstaller');
const python =
  process.env.TURNNOTE_PACKAGING_PYTHON ??
  (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');

const dependencies = spawnSync(
  python,
  ['-c', 'import av, ctranslate2, faster_whisper, onnxruntime'],
  { stdio: 'ignore' },
);
if (dependencies.status !== 0) {
  console.error('ASR runtime dependencies are missing from the packaging Python environment.');
  console.error('Install requirements.txt and requirements-dev.txt before building the sidecar.');
  process.exit(1);
}

const result = spawnSync(
  executable,
  [
    '--noconfirm',
    '--clean',
    '--onedir',
    '--collect-all',
    'faster_whisper',
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
