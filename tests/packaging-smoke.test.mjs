import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPackagedSidecar, runPackagingSmoke } from '../out/tests/runtime.mjs';
import { pythonExecutable } from './support/python.mjs';

function child(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'turnnote-package-ping-'));
  const pidFile = join(root, 'pid');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    command: {
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${body}`,
      ],
    },
    dead() {
      assert.ok(existsSync(pidFile), 'the child actually started');
      assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), {
        code: 'ESRCH',
      });
    },
  };
}

const pong = JSON.stringify({ id: 'packaging-smoke', type: 'pong', status: 'ok' }) + '\n';

test('packaged sidecar ping accepts the real Python worker', async () => {
  await checkPackagedSidecar({
    command: pythonExecutable(),
    args: [resolve('services/asr-worker/worker.py')],
  });
});

test('a successful ping waits for child termination, including forced cleanup', async (t) => {
  const f = child(
    t,
    `
    process.on('SIGTERM', () => {});
    process.stdin.once('data', () => process.stdout.write(${JSON.stringify(pong)}));
    setInterval(() => {}, 1000);
  `,
  );
  await checkPackagedSidecar(f.command);
  f.dead();
});

for (const [name, body, error] of [
  ['early clean exit', 'process.exit(0)', /exited before pong|input closed/],
  ['early crash', 'process.exit(2)', /exited before pong|input closed/],
  [
    'invalid JSON',
    "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000);",
    /invalid JSON/,
  ],
  [
    'null response',
    "process.stdout.write('null\\n'); setInterval(() => {}, 1000);",
    /unexpected ping response/,
  ],
  [
    'wrong job',
    `process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'old', type: 'pong', status: 'ok' }) + '\n')}); setInterval(() => {}, 1000);`,
    /unexpected ping response/,
  ],
  [
    'missing status',
    `process.stdout.write(${JSON.stringify(JSON.stringify({ id: 'packaging-smoke', type: 'pong' }) + '\n')}); setInterval(() => {}, 1000);`,
    /unexpected ping response/,
  ],
  [
    'stdout limit',
    "process.stdout.write('x'.repeat(65537)); setInterval(() => {}, 1000);",
    /output exceeded/,
  ],
  [
    'stderr limit',
    "process.stderr.write('x'.repeat(65537)); setInterval(() => {}, 1000);",
    /output exceeded/,
  ],
  ['timeout', 'setInterval(() => {}, 1000);', /timed out/],
]) {
  test(`packaging ping rejects ${name} and releases the process`, async (t) => {
    const f = child(t, body);
    await assert.rejects(checkPackagedSidecar(f.command, name === 'timeout' ? 1000 : 5000), error);
    f.dead();
  });
}

test('split ping lines remain valid', async (t) => {
  const midpoint = Math.floor(pong.length / 2);
  const f = child(
    t,
    `
    process.stdin.once('data', () => {
      process.stdout.write(${JSON.stringify(pong.slice(0, midpoint))});
      setTimeout(() => process.stdout.write(${JSON.stringify(pong.slice(midpoint))}), 10);
    });
    setInterval(() => {}, 1000);
  `,
  );
  await checkPackagedSidecar(f.command);
  f.dead();
});

test('missing installed sidecar writes a failed report after a real SQLite check', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'turnnote-package-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { passed, logPath } = await runPackagingSmoke(
    join(root, 'resources'),
    join(root, 'user data'),
  );
  assert.equal(passed, false);
  const report = JSON.parse(readFileSync(logPath, 'utf8'));
  assert.equal(report.platform, process.platform);
  assert.equal(report.architecture, process.arch);
  assert.equal(report.electronVersion, 'unknown');
  assert.equal(report.modulesAbi, process.versions.modules);
  assert.equal(report.sqlite, 'ok');
  assert.equal(report.sidecar, 'failed');
  assert.equal(
    report.sidecarResource,
    `asr-worker/${process.platform === 'win32' ? 'asr-worker.exe' : 'asr-worker'}`,
  );
  assert.equal(report.errorCode, 'SIDECAR_CHECK_FAILED');
  assert.equal(Object.hasOwn(report, 'error'), false);
  assert.equal(JSON.stringify(report).includes(root), false);
});

test('successful packaging report uses only fixed diagnostic fields', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'turnnote-package-success-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { passed, logPath } = await runPackagingSmoke(
    join(root, 'private resources'),
    join(root, 'user data'),
    {
      sqlite() {},
      async sidecar() {},
    },
  );
  const reportText = readFileSync(logPath, 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(passed, true);
  assert.equal(report.sqlite, 'ok');
  assert.equal(report.sidecar, 'ok');
  assert.equal(Object.hasOwn(report, 'errorCode'), false);
  assert.equal(reportText.includes(root), false);
});

test('SQLite failure report never includes exception details or local paths', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'turnnote-package-sqlite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = 'sk-private-credential and complete confidential transcript and meeting note';
  let sidecarCalled = false;
  const { passed, logPath } = await runPackagingSmoke(
    join(root, 'private resources'),
    join(root, 'user data'),
    {
      sqlite() {
        throw new Error(`${secret} at ${root}/turnnote.db`);
      },
      async sidecar() {
        sidecarCalled = true;
      },
    },
  );
  const reportText = readFileSync(logPath, 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(passed, false);
  assert.equal(sidecarCalled, false);
  assert.equal(report.sqlite, 'failed');
  assert.equal(report.sidecar, 'failed');
  assert.equal(report.errorCode, 'SQLITE_CHECK_FAILED');
  for (const value of [secret, root, 'turnnote.db'])
    assert.equal(reportText.includes(value), false);
});
