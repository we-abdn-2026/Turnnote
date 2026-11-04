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
    // Vite 在应用构建里静态替换它；测试构建里同样替换，组件按生产（非开发）模式渲染
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [
      {
        name: 'worklet-test-url',
        setup(builder) {
          builder.onResolve({ filter: /\?worker&url$/ }, () => ({
            path: 'worklet-test',
            namespace: 'test-url',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'test-url' }, () => ({
            contents: 'export default "worklet-test.js";',
            loader: 'js',
          }));
        },
      },
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
