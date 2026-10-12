import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPackage } from '@electron/asar';
import { verifyPackageContents } from '../scripts/verify-package-contents.mjs';

const projectPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

async function fixture(t, layout, extraFiles = {}, includeMain = true) {
  const directory = mkdtempSync(join(tmpdir(), 'turnnote-package-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const app = join(directory, 'Turnnote.app');
  const resources = join(app, layout === 'mac' ? 'Contents/Resources' : 'resources');
  mkdirSync(resources, { recursive: true });
  const files = {
    'package.json': JSON.stringify({
      name: projectPackage.name,
      version: projectPackage.version,
      main: projectPackage.main,
    }),
    ...(includeMain ? { [projectPackage.main]: 'console.log("ready")' } : {}),
    ...extraFiles,
  };
  for (const [path, content] of Object.entries(files)) {
    const destination = join(source, path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, content);
  }
  await createPackage(source, join(resources, 'app.asar'));
  return app;
}

test('accepts macOS and Windows packages with the declared entry point', async (t) => {
  for (const layout of ['mac', 'windows']) {
    const app = await fixture(t, layout);
    assert.doesNotThrow(() => verifyPackageContents(app));
  }
});

test('rejects a development dependency and a private file in the package', async (t) => {
  const development = await fixture(t, 'mac', { 'node_modules/eslint/index.js': 'dev only' });
  assert.throws(() => verifyPackageContents(development), /Development dependency/);

  const privateConfig = await fixture(t, 'windows', { 'out/settings.pem': 'private' });
  assert.throws(() => verifyPackageContents(privateConfig), /Private configuration/);
});

test('rejects a package without its application entry point', async (t) => {
  const app = await fixture(t, 'mac', {}, false);
  assert.throws(() => verifyPackageContents(app), /entry point is missing/);
});
