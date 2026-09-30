import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pythonExecutable } from './support/python.mjs';

const WORKER = 'services/asr-worker/worker.py';
// 任意存在的文件即可通过 AUDIO_NOT_FOUND 检查；fake 模式不解码音频
const EXISTING_FILE = 'package.json';

function run(requests, args = []) {
  const result = spawnSync(pythonExecutable(), [WORKER, ...args], {
    input: requests.map((request) => JSON.stringify(request) + '\n').join(''),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function transcribeRequest(overrides = {}) {
  return {
    id: 't-1',
    type: 'transcribe',
    audioPath: EXISTING_FILE,
    language: 'en',
    modelPath: 'models/small',
    ...overrides,
  };
}

test('answers ping', () => {
  assert.deepEqual(run([{ id: 'p-1', type: 'ping' }]), [{ id: 'p-1', type: 'pong', status: 'ok' }]);
});

test('reports invalid JSON and keeps running', () => {
  const result = spawnSync(pythonExecutable(), [WORKER], {
    input: 'not json\n{"id":"p-2","type":"ping"}\n',
    encoding: 'utf8',
  });
  const [first, second] = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(first.code, 'INVALID_JSON');
  assert.equal(second.type, 'pong');
});

test('rejects unknown request type', () => {
  const [response] = run([{ id: 'u-1', type: 'unknown' }]);
  assert.equal(response.code, 'UNKNOWN_REQUEST');
});

test('rejects transcribe with missing fields', () => {
  const [response] = run([{ id: 't-0', type: 'transcribe' }]);
  assert.equal(response.id, 't-0');
  assert.equal(response.code, 'INVALID_REQUEST');
});

test('rejects unsupported language', () => {
  const [response] = run([transcribeRequest({ language: 'fr' })]);
  assert.equal(response.code, 'INVALID_REQUEST');
});

test('reports missing audio file', () => {
  const [response] = run([transcribeRequest({ audioPath: 'does/not/exist.wav' })]);
  assert.equal(response.code, 'AUDIO_NOT_FOUND');
});

test('real transcription is not implemented yet', () => {
  const [response] = run([transcribeRequest()]);
  assert.equal(response.code, 'NOT_IMPLEMENTED');
});

test('fake mode streams progress, segments and done', () => {
  const responses = run([transcribeRequest({ language: 'auto' })], ['--fake']);
  const types = responses.map((response) => response.type);
  assert.deepEqual(types, ['progress', 'segment', 'segment', 'segment', 'progress', 'done']);
  assert.ok(responses.every((response) => response.id === 't-1'));

  const segments = responses.filter((response) => response.type === 'segment');
  const done = responses.at(-1);
  assert.equal(done.segmentCount, segments.length);
  assert.equal(done.detectedLanguage, 'en');
  assert.equal(done.durationMs, segments.at(-1).endMs);
  for (const segment of segments) assert.ok(segment.endMs > segment.startMs);
});

test('shutdown stops processing later requests', () => {
  const responses = run([
    { id: 's-1', type: 'shutdown' },
    { id: 'p-3', type: 'ping' },
  ]);
  assert.deepEqual(responses, []);
});
