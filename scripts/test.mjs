import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { buildRuntime } from '../tests/support/build-runtime.mjs';

// 正式 SQL 迁移通过 ?raw 打包，与 electron-vite 使用同一份源文件。
await buildRuntime();
const files = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    '--test',
    ...(files.length
      ? files
      : readdirSync('tests')
          .filter((file) => file.endsWith('.test.mjs'))
          .map((file) => `tests/${file}`)),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
