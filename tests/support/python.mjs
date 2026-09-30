import { existsSync } from 'node:fs';
import { join } from 'node:path';

// 优先使用 TURNNOTE_PYTHON，其次项目 .venv，最后系统 Python
export function pythonExecutable() {
  if (process.env.TURNNOTE_PYTHON) return process.env.TURNNOTE_PYTHON;
  const venv =
    process.platform === 'win32'
      ? join('.venv', 'Scripts', 'python.exe')
      : join('.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}
