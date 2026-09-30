import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('ASR sidecar answers protocol ping', () => {
  const result = spawnSync('python3', ['services/asr-worker/worker.py'], {
    cwd: process.cwd(),
    input: '{"id":"test-1","type":"ping"}\n',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: 'test-1',
    type: 'pong',
    status: 'ok',
  });
});

test('ASR sidecar reports unsupported work without crashing', () => {
  const result = spawnSync('python3', ['services/asr-worker/worker.py'], {
    cwd: process.cwd(),
    input: '{"id":"test-2","type":"transcribe"}\n',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.id, 'test-2');
  assert.equal(response.type, 'error');
  assert.equal(response.code, 'NOT_IMPLEMENTED');
});
