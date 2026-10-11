import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, truncateSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAudioWriter,
  repairWavHeader,
  createRecordingHandlers,
  MeetingStore,
  createDispatcher,
  PcmEncoder,
} from '../out/tests/runtime.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'turnnote-audio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function checkWav(path, samples) {
  const data = readFileSync(path);
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(data.readUInt32LE(4), data.length - 8);
  assert.equal(data.readUInt32LE(24), 16000);
  assert.equal(data.readUInt16LE(22), 1);
  assert.equal(data.readUInt16LE(34), 16);
  assert.equal(data.readUInt32LE(40), samples.length * 2);
  assert.deepEqual(
    Array.from({ length: samples.length }, (_, i) => data.readInt16LE(44 + i * 2)),
    samples,
  );
}

test('WAV writer preserves samples and offsets, finalizes idempotently, rejects invalid and closed writes', async (t) => {
  const path = join(fixture(t), 'audio.wav');
  const writer = createAudioWriter(path);
  writer.append(new Int16Array([-32768, 0, 32767]));
  writer.append(new Int16Array([111, 222, 333]).subarray(1));
  assert.throws(() => writer.append(new Uint8Array(2)), { code: 'INVALID_INPUT' });
  assert.throws(() => writer.append(new Int16Array(32001)), { code: 'INVALID_INPUT' });
  await writer.finalize();
  await writer.finalize();
  checkWav(path, [-32768, 0, 32767, 222, 333]);
  assert.throws(() => writer.append(new Int16Array([1])), { code: 'INVALID_STATE' });
  assert.throws(() => createAudioWriter(path), { code: 'WRITE_FAILED' });
});

test('repair recovers stale lengths and truncation, discards half a sample, rejects empty and unknown files', async (t) => {
  const root = fixture(t);
  const path = join(root, 'audio.wav');
  const writer = createAudioWriter(path);
  writer.append(new Int16Array([12, 34, 56]));
  await writer.finalize();
  truncateSync(path, 49);
  assert.equal(await repairWavHeader(path), true);
  checkWav(path, [12, 34]);
  assert.equal(await repairWavHeader(path), true);
  writeFileSync(join(root, 'bad.wav'), Buffer.alloc(100));
  const empty = createAudioWriter(join(root, 'empty.wav'));
  await empty.finalize();
  assert.equal(await repairWavHeader(join(root, 'empty.wav')), false);
  assert.equal(await repairWavHeader(join(root, 'bad.wav')), false);
  assert.equal(await repairWavHeader(join(root, 'missing.wav')), false);
});

test('recording handlers enforce job identity, serialize stop/cancel, and keep Renderer free of paths', async (t) => {
  const root = fixture(t);
  const store = new MeetingStore(join(root, 'db.sqlite'), root);
  t.after(() => store.close());
  const events = [];
  const recording = createRecordingHandlers(
    store,
    root,
    (meeting) => events.push(meeting),
    () => ({ microphone: 'unknown', screen: 'granted' }),
  );
  const dispatch = createDispatcher(recording.handlers);
  const id = store.create('Audio test').id;
  const start = await dispatch('recording:start', [id]);
  assert.equal(start.ok, true);
  const job = start.value.activeJobId;
  assert.equal(
    (await dispatch('recording:append-chunk', [id, 'old-job', new Int16Array([1])])).error.code,
    'INVALID_STATE',
  );
  assert.equal(
    (await dispatch('recording:append-chunk', [id, job, new Uint8Array(2)])).error.code,
    'INVALID_INPUT',
  );
  assert.equal(
    (await dispatch('recording:append-chunk', [id, job, new Int16Array([123, -456])])).ok,
    true,
  );
  const [stop, cancel] = await Promise.all([
    dispatch('recording:stop', [id, job]),
    dispatch('recording:cancel', [id, job]),
  ]);
  assert.equal(stop.value.status, 'captured');
  assert.equal(cancel.error.code, 'INVALID_STATE');
  checkWav(store.getAudio(id).filePath, [123, -456]);
  assert.equal((await dispatch('recording:stop', [id, job])).error.code, 'INVALID_STATE');
  assert.ok(!JSON.stringify(events).includes(root));
});

test('failed capture retains WAV until explicit discard; stale failure cannot end retry', async (t) => {
  const root = fixture(t);
  const store = new MeetingStore(join(root, 'db.sqlite'), root);
  t.after(() => store.close());
  const recording = createRecordingHandlers(
    store,
    root,
    () => {},
    () => ({ microphone: 'denied', screen: 'denied' }),
  );
  const dispatch = createDispatcher(recording.handlers);
  const id = store.create('Failure test').id;
  const job = (await dispatch('recording:start', [id])).value.activeJobId;
  await dispatch('recording:append-chunk', [id, job, new Int16Array([7])]);
  const failed = await dispatch('recording:fail', [id, job, 'PERMISSION_DENIED']);
  assert.equal(failed.value.status, 'failed');
  assert.equal(failed.value.lastError.code, 'PERMISSION_DENIED');
  checkWav(store.getAudio(id).filePath, [7]);
  assert.equal((await dispatch('recording:cancel', [id, job])).value.status, 'created');
  assert.equal(store.getAudio(id), null);
  const retry = (await dispatch('recording:start', [id])).value.activeJobId;
  assert.notEqual(retry, job);
  assert.equal(
    (await dispatch('recording:fail', [id, job, 'CAPTURE_FAILED'])).error.code,
    'INVALID_STATE',
  );
  await recording.shutdown();
  assert.equal(store.get(id).lastError.code, 'INTERRUPTED');
});

test('restart repairs interrupted recording and retains recoverable data', async (t) => {
  const root = fixture(t);
  const store = new MeetingStore(join(root, 'db.sqlite'), root);
  t.after(() => store.close());
  const id = store.create('Interrupted').id;
  const path = join(root, 'interrupted.wav');
  const writer = createAudioWriter(path);
  store.beginRecording(id, path);
  writer.append(new Int16Array([9, 10]));
  const recording = createRecordingHandlers(
    store,
    root,
    () => {},
    () => ({ microphone: 'unknown', screen: 'unknown' }),
  );
  await recording.recover();
  checkWav(path, [9, 10]);
  assert.equal(store.get(id).lastError.code, 'INTERRUPTED');
  await writer.finalize();
});

test('disk creation failure never leaves recording state or leaks paths', async (t) => {
  const root = fixture(t);
  const store = new MeetingStore(join(root, 'db.sqlite'), root);
  t.after(() => store.close());
  const unavailable = join(root, 'does-not-exist');
  const recording = createRecordingHandlers(
    store,
    unavailable,
    () => {},
    () => ({ microphone: 'unknown', screen: 'unknown' }),
  );
  const dispatch = createDispatcher(recording.handlers);
  const id = store.create('Disk failure').id;
  assert.equal((await dispatch('recording:start', [id])).error.code, 'WRITE_FAILED');
  assert.equal(store.get(id).status, 'created');
  mkdirSync(unavailable);
  const started = await dispatch('recording:start', [id]);
  const path = store.getAudio(id).filePath;
  // Replace the file with a directory to force unlink failure; reference must be kept.
  await recording.shutdown();
  rmSync(path);
  mkdirSync(path);
  const failed = await dispatch('recording:cancel', [id, started.value.activeJobId]);
  assert.equal(failed.error.code, 'WRITE_FAILED');
  assert.equal(store.get(id).hasAudio, true);
  assert.ok(!JSON.stringify(failed).includes(root));
});

test('PCM encoder handles stereo mix, clipping, fractional resampling and final partial block', () => {
  const chunks = [];
  const encoder = new PcmEncoder(48000, (chunk) => chunks.push(chunk));
  const input = new Float32Array(48000).fill(0.5);
  for (let i = 0; i < input.length; i += 128)
    encoder.push([
      [input.subarray(i, i + 128), input.subarray(i, i + 128)],
      [input.subarray(i, i + 128)],
    ]);
  encoder.flush();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 16000);
  assert.ok(chunks[0].every((value) => value === 16384));
  for (const rate of [44100, 48000, 16000]) {
    const output = [];
    const resampler = new PcmEncoder(rate, (chunk) => output.push(...chunk));
    for (let i = 0; i < rate; i += 128)
      resampler.push([[new Float32Array(Math.min(128, rate - i)).fill(-2)]]);
    resampler.flush();
    assert.equal(output.length, 16000);
    assert.ok(output.every((value) => value === -32768));
  }
  const final = [];
  const partial = new PcmEncoder(16000, (chunk) => final.push(...chunk));
  partial.push([[new Float32Array([1, -1, 0])]]);
  partial.flush();
  partial.flush();
  assert.deepEqual(final, [32767, -32768, 0]);
});

test('partial disk write is reported, closes descriptor and preserves complete samples for repair', async (t) => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const path = join(fixture(t), 'partial.wav');
  const writer = createAudioWriter(path);
  const original = fs.default.writeSync;
  let wroteSample = false;
  const mocked = t.mock.method(fs.default, 'writeSync', (fd, buffer, offset, length, position) => {
    if (position >= 44) {
      if (wroteSample) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      wroteSample = true;
      return original(fd, buffer, offset, 2, position);
    }
    return original(fd, buffer, offset, length, position);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => writer.append(new Int16Array([123, 456, 789])), { code: 'WRITE_FAILED' });
    await assert.rejects(writer.finalize(), { code: 'WRITE_FAILED' });
    await assert.rejects(writer.finalize(), { code: 'WRITE_FAILED' });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await repairWavHeader(path), true);
  checkWav(path, [123]);
});
