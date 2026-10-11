import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCapture } from '../out/tests/runtime.mjs';

import { captureEnvironment as environment } from './support/capture-environment.mjs';

const options = { meetingId: 'meeting', microphoneDeviceId: 'default', includeSystemAudio: true };

test('capture stop flushes the final partial PCM block before Main stop and closes all resources', async (t) => {
  const env = environment(t);
  const session = await startCapture(options, env.api);
  await Promise.all([session.stop(), session.stop()]);
  const chunk = env.calls.findIndex((call) => Array.isArray(call) && call[0] === 'chunk');
  assert.deepEqual(env.calls[chunk], ['chunk', 'meeting', 'job', [11, 22, 33]]);
  assert.ok(chunk < env.calls.indexOf('stop'));
  assert.equal(env.calls.filter((call) => call === 'stop').length, 1);
  assert.equal(env.context().state, 'closed');
  assert.ok(env.tracks.every((track) => track.stopped));
});

test('system permission denial disables loopback, warns, and explicitly falls back to microphone', async (t) => {
  const env = environment(t, { systemDenied: true });
  const warnings = [];
  const session = await startCapture(
    { ...options, onWarning: (warning) => warnings.push(warning) },
    env.api,
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(env.calls.slice(0, 3), ['start', 'enable', 'disable']);
  await session.cancel();
  assert.ok(env.calls.includes('cancel'));
  assert.ok(env.tracks.every((track) => track.stopped));
});

test('microphone permission denial releases previously acquired system stream and reports failure', async (t) => {
  const env = environment(t, { micDenied: true });
  await assert.rejects(startCapture(options, env.api), { code: 'PERMISSION_DENIED' });
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.deepEqual(env.calls.at(-1), ['fail', 'PERMISSION_DENIED']);
  assert.ok(!env.calls.includes('stop'));
});

test('failed final chunk reports WRITE_FAILED and cannot claim captured', async (t) => {
  const env = environment(t, { writeFailed: true });
  const session = await startCapture(options, env.api);
  await assert.rejects(session.stop(), { code: 'WRITE_FAILED' });
  assert.ok(
    env.calls.some(
      (call) => Array.isArray(call) && call[0] === 'fail' && call[1] === 'WRITE_FAILED',
    ),
  );
  assert.ok(!env.calls.includes('stop'));
  assert.ok(env.tracks.every((track) => track.stopped));
});

test('source ending while Worklet initializes fails start and releases resources', async (t) => {
  const env = environment(t, { duringModule: (tracks) => tracks[0].end() });
  await assert.rejects(startCapture(options, env.api), { code: 'CAPTURE_FAILED' });
  assert.deepEqual(env.calls.at(-1), ['fail', 'CAPTURE_FAILED']);
  assert.equal(env.context().state, 'closed');
  assert.ok(env.tracks.every((track) => track.stopped));
});

test('ended readyState without a delivered event is rejected across initialization', async (t) => {
  const env = environment(t, {
    duringModule: (tracks) => {
      tracks[0].readyState = 'ended';
    },
  });
  await assert.rejects(startCapture(options, env.api), { code: 'CAPTURE_FAILED' });
  assert.deepEqual(env.calls.at(-1), ['fail', 'CAPTURE_FAILED']);
});

test('system source ending during microphone permission wait also stops the late microphone', async (t) => {
  const env = environment(t, {
    duringMic: async (tracks) => {
      tracks[0].end();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  });
  await assert.rejects(startCapture(options, env.api), { code: 'CAPTURE_FAILED' });
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.deepEqual(env.calls.at(-1), ['fail', 'CAPTURE_FAILED']);
  assert.equal(env.context(), undefined);
});

for (const trigger of ['track', 'processor', 'write']) {
  test(`session cancel completes once after ${trigger} failure without closing Context twice`, async (t) => {
    const env = environment(t, { writeFailed: trigger === 'write' });
    const session = await startCapture(options, env.api);
    if (trigger === 'track') env.tracks[0].end();
    if (trigger === 'processor') env.worklet().onprocessorerror();
    if (trigger === 'write') await assert.rejects(session.stop(), { code: 'WRITE_FAILED' });
    await Promise.all([session.cancel(), session.cancel()]);
    assert.equal(env.calls.filter((call) => call === 'cancel').length, 1);
    assert.equal(env.calls.filter((call) => call === 'close-context').length, 1);
    const fail = env.calls.findIndex((call) => Array.isArray(call) && call[0] === 'fail');
    assert.ok(fail < env.calls.indexOf('cancel'));
    assert.ok(env.tracks.every((track) => track.stopped));
  });
}
