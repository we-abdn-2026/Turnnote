import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeLogger, safeLogPath } from '../out/tests/runtime.mjs';

const PRIVATE = {
  key: 'sk-private-credential-123',
  path: '/Users/private/meetings/customer-plan.wav',
  transcript: 'Complete private transcript about an acquisition.',
  note: 'Complete private meeting note with every decision.',
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'turnnote-safe-log-'));
  const path = safeLogPath(root);
  const logger = new SafeLogger(path);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { logger, path };
}

function entries(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('safe logger keeps codes and diagnostic categories without credential, path or meeting text', (t) => {
  const { logger, path } = fixture(t);
  const secret = Object.values(PRIVATE).join(' | ');
  logger.error('main', 'startup_failed', 'INTERNAL', new Error(secret));
  logger.error('deepseek', 'request_failed', 'DEEPSEEK_UNAUTHORIZED', new Error(secret));
  logger.sidecarFailure(
    'SIDECAR_CRASHED',
    `[asr-worker] decode failed: InvalidDataError\n${secret}`,
    new Error(secret),
  );
  logger.ipcFailure({
    channel: PRIVATE.transcript,
    code: 'INVALID_INPUT',
    cause: new Error(secret),
  });
  logger.ipcFailure({ channel: 'meetings:get', code: 'INTERNAL', cause: new Error(secret) });

  const text = readFileSync(path, 'utf8');
  for (const value of Object.values(PRIVATE)) assert.equal(text.includes(value), false);
  assert.deepEqual(
    entries(path).map(({ source, event, code, operation, exceptionType, diagnosticStage }) => ({
      source,
      event,
      code,
      operation,
      exceptionType,
      diagnosticStage,
    })),
    [
      {
        source: 'main',
        event: 'startup_failed',
        code: 'INTERNAL',
        operation: undefined,
        exceptionType: 'Error',
        diagnosticStage: undefined,
      },
      {
        source: 'deepseek',
        event: 'request_failed',
        code: 'DEEPSEEK_UNAUTHORIZED',
        operation: undefined,
        exceptionType: 'Error',
        diagnosticStage: undefined,
      },
      {
        source: 'sidecar',
        event: 'transcription_failed',
        code: 'SIDECAR_CRASHED',
        operation: undefined,
        exceptionType: 'Error',
        diagnosticStage: 'decode',
      },
      {
        source: 'ipc',
        event: 'request_failed',
        code: 'INVALID_INPUT',
        operation: 'unknown',
        exceptionType: 'Error',
        diagnosticStage: undefined,
      },
      {
        source: 'ipc',
        event: 'request_failed',
        code: 'INTERNAL',
        operation: 'meetings:get',
        exceptionType: 'Error',
        diagnosticStage: undefined,
      },
    ],
  );
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});
