import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPackage } from '@electron/asar';
import {
  normalizeArchivePath,
  verifyPackageContents,
} from '../scripts/verify-package-contents.mjs';

const projectPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

test('normalizes ASAR paths returned by Windows', () => {
  assert.equal(normalizeArchivePath('\\node_modules\\react'), 'node_modules/react');
  assert.equal(normalizeArchivePath('/out/main/index.js'), 'out/main/index.js');
});

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

function addResource(app, layout, path, content) {
  const resources = join(app, layout === 'mac' ? 'Contents/Resources' : 'resources');
  const destination = join(resources, path);
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, content);
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

test('accepts sidecar and native module resources on macOS and Windows', async (t) => {
  for (const layout of ['mac', 'windows']) {
    const app = await fixture(t, layout);
    addResource(app, layout, 'asr-worker/_internal/runtime.dat', 'runtime');
    addResource(
      app,
      layout,
      'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'native module',
    );
    assert.doesNotThrow(() => verifyPackageContents(app));
  }
});

test('rejects private files nested in sidecar resources on macOS and Windows', async (t) => {
  for (const layout of ['mac', 'windows']) {
    const app = await fixture(t, layout);
    addResource(app, layout, 'asr-worker/_internal/.env', 'synthetic marker');
    assert.throws(() => verifyPackageContents(app), /Private configuration.*\.env/);

    const appWithKey = await fixture(t, layout);
    addResource(appWithKey, layout, 'asr-worker/config/signing.pem', 'synthetic marker');
    assert.throws(() => verifyPackageContents(appWithKey), /Private configuration.*signing\.pem/);
  }
});
