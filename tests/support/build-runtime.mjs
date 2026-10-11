import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** 测试与 Electron smoke 共用正式 TypeScript/SQL 构建入口。 */
export async function buildRuntime() {
  mkdirSync('out/tests', { recursive: true });
  await build({
    entryPoints: ['tests/support/runtime.ts'],
    outfile: 'out/tests/runtime.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    loader: { '.sql': 'text' },
    plugins: [
      {
        name: 'sql-raw',
        setup(builder) {
          builder.onResolve({ filter: /\.sql\?raw$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.slice(0, -4)),
          }));
        },
      },
    ],
  });
}
