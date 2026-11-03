import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDispatcher,
  createInvokeApi,
  invokeChannels,
  invokeSchemas,
  eventChannels,
  loopbackChannels,
  errorMessages,
  ok,
  TurnnoteError,
} from '../out/tests/runtime.mjs';

const NOTE = {
  summary: 'Review',
  keyTopics: [],
  decisions: [],
  openQuestions: [],
  actionItems: [],
};

test('Preload bridge, schemas and Main dispatcher cover exactly the same invoke whitelist', async () => {
  const channels = [];
  const calls = [];
  const bridge = createInvokeApi(async (channel, ...args) => {
    calls.push({ channel, args });
    return ok(null);
  });
  assert.deepEqual(Object.keys(bridge), Object.keys(invokeChannels));
  for (const [namespace, methods] of Object.entries(invokeChannels)) {
    assert.deepEqual(Object.keys(bridge[namespace]), Object.keys(methods));
    assert.deepEqual(Object.keys(invokeSchemas[namespace]), Object.keys(methods));
    for (const [method, channel] of Object.entries(methods)) {
      await bridge[namespace][method]('sentinel');
      channels.push(channel);
      assert.deepEqual(calls.at(-1), { channel, args: ['sentinel'] });
    }
  }
  assert.equal(new Set(channels).size, channels.length);
  assert.deepEqual(eventChannels, {
    meetingUpdated: 'events:meeting-updated',
    jobProgress: 'events:job-progress',
  });
  assert.deepEqual(loopbackChannels, {
    enable: 'enable-loopback-audio',
    disable: 'disable-loopback-audio',
  });
  assert.equal('invoke' in bridge, false);
});

test('Main normalizes validated arguments and rejects malformed input before side effects', async () => {
  const received = [];
  const dispatch = createDispatcher({
    meetings: {
      create: async (title) => {
        received.push(title);
        return ok(title);
      },
    },
  });
  assert.deepEqual(await dispatch('meetings:create', ['  Review  ']), ok('Review'));
  for (const args of [[], [''], [null], [42], ['x'.repeat(201)], ['Review', 'extra']]) {
    assert.equal((await dispatch('meetings:create', args)).error.code, 'INVALID_INPUT');
  }
  assert.deepEqual(received, ['Review']);
  assert.equal((await dispatch('made-up:channel', [])).error.code, 'INVALID_INPUT');
  assert.equal((await dispatch('recording:start', ['meeting-1'])).error.code, 'NOT_IMPLEMENTED');
  assert.equal((await dispatch('recording:start', [null])).error.code, 'INVALID_INPUT');
  assert.equal((await dispatch('app:get-info', ['extra'])).error.code, 'INVALID_INPUT');
});

test('IPC validates PCM chunk type and upper bound, capture failure codes, note versions and credential separation', async () => {
  const dispatch = createDispatcher({
    recording: { appendChunk: async () => ok(null), fail: async () => ok(null) },
    notes: { saveEdit: async () => ok(null) },
    settings: { update: async (patch) => ok(patch) },
  });
  assert.equal(
    (await dispatch('recording:append-chunk', ['meeting', 'job', new Int16Array(16000)])).ok,
    true,
  );
  for (const chunk of [[], new Uint8Array(2), new Int16Array(0), new Int16Array(32001)])
    assert.equal(
      (await dispatch('recording:append-chunk', ['meeting', 'job', chunk])).error.code,
      'INVALID_INPUT',
    );
  assert.equal((await dispatch('recording:fail', ['meeting', 'job', 'CAPTURE_FAILED'])).ok, true);
  assert.equal(
    (await dispatch('recording:fail', ['meeting', 'job', 'INTERNAL'])).error.code,
    'INVALID_INPUT',
  );
  assert.equal((await dispatch('notes:save-edit', ['meeting', NOTE, 0])).ok, true);
  for (const args of [
    ['meeting', NOTE],
    ['meeting', NOTE, -1],
    ['meeting', { ...NOTE, apiKey: 'secret' }, 1],
    ['meeting', { ...NOTE, decisions: [{ text: 'Decision', timestampMs: -1 }] }, 1],
  ])
    assert.equal((await dispatch('notes:save-edit', args)).error.code, 'INVALID_INPUT');
  assert.equal(
    (await dispatch('settings:update', [{ apiKey: 'secret' }])).error.code,
    'INVALID_INPUT',
  );
  assert.equal(
    (await dispatch('settings:update', [{ includeSystemAudio: undefined }])).error.code,
    'INVALID_INPUT',
  );
  assert.equal(
    (await dispatch('settings:update', [{ transcriptionModel: '../../escape' }])).error.code,
    'INVALID_INPUT',
  );
});

test('expected domain errors use safe messages; unexpected failures leak no exception data into logs or Result', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const dispatch = createDispatcher({
    meetings: {
      get: async () => {
        throw new Error('private/path transcript api-key');
      },
      create: async () => {
        throw new TurnnoteError('INVALID_STATE');
      },
    },
  });
  const result = await dispatch('meetings:get', ['meeting']);
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'INTERNAL', message: errorMessages.INTERNAL },
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(logs, []);
  assert.deepEqual(await dispatch('meetings:create', ['Review']), {
    ok: false,
    error: { code: 'INVALID_STATE', message: errorMessages.INVALID_STATE },
  });
});
