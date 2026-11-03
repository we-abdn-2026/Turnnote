import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAudioRetention,
  createDispatcher,
  createInvokeApi,
  createSessionServices,
  MeetingStore,
  removeManagedFile,
} from '../out/tests/runtime.mjs';

const SEGMENTS = [{ startMs: 0, endMs: 1000, text: 'Controlled audio' }];
const NOTE = {
  summary: 'Summary',
  keyTopics: [],
  decisions: [],
  openQuestions: [],
  actionItems: [],
};
const errorCode = (code) => (error) => error.code === code;
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('state not reached within 5 seconds');
}
function stub(body) {
  return {
    command: process.execPath,
    args: [
      '-e',
      `const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
       require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
         const msg = JSON.parse(line);
         if (msg.type === 'ping') out({ id: msg.id, type: 'pong', status: 'ok' });
         if (msg.type === 'transcribe') { ${body} }
         if (msg.type === 'shutdown') process.exit(0);
       });`,
    ],
  };
}
const succeeds = () =>
  stub(`
    for (const segment of ${JSON.stringify(SEGMENTS)}) out({ id: msg.id, type: 'segment', ...segment });
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 1 });
  `);
const crashes = () => stub('process.exit(1);');

function fixture(t, { sidecar = () => assert.fail('sidecar must not start'), logger } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-retention-')));
  const audioDirectory = join(root, 'audio');
  mkdirSync(audioDirectory);
  const store = new MeetingStore(join(root, 'turnnote.db'), audioDirectory);
  const events = [];
  const services = createSessionServices(store, {
    audioDirectory,
    modelsDirectory: join(root, 'models'),
    sidecar: () => sidecar(),
    permissions: () => ({ microphone: 'unknown', screen: 'unknown' }),
    emitMeeting: (meeting) => events.push(meeting),
    emitProgress: () => {},
    logger,
  });
  const dispatch = createDispatcher(services.handlers);
  const api = createInvokeApi((channel, ...args) => dispatch(channel, args));
  t.after(async () => {
    await services.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  return {
    root,
    audioDirectory,
    store,
    services,
    api,
    events,
    retention: createAudioRetention(store, audioDirectory, logger),
    captured(title = 'Meeting') {
      const path = join(audioDirectory, `audio-${++n}.wav`);
      writeFileSync(path, 'controlled input');
      return { id: store.createCaptured(title, path).id, path };
    },
    transcribed(title) {
      const meeting = this.captured(title);
      const job = store.beginTranscription(meeting.id);
      assert.equal(store.completeTranscription(job.id, SEGMENTS), true);
      return meeting;
    },
  };
}

test('successful transcription removes audio and reference; the final event already reports hasAudio false', async (t) => {
  const f = fixture(t, { sidecar: succeeds });
  const { id, path } = f.captured();
  value(await f.api.transcription.start(id));
  await until(() => f.store.get(id).status === 'transcribed');
  assert.equal(existsSync(path), false);
  assert.equal(f.store.getAudio(id), null);
  assert.equal(f.store.get(id).hasAudio, false);
  const last = f.events.filter((meeting) => meeting.id === id).at(-1);
  assert.equal(last.status, 'transcribed');
  assert.equal(last.hasAudio, false);
  assert.deepEqual(f.store.getSegments(id), SEGMENTS);
});

test('a meeting marked retain keeps its audio; the policy flag and hasAudio are independent', async (t) => {
  const f = fixture(t, { sidecar: succeeds });
  const { id, path } = f.captured();
  value(await f.api.meetings.setRetainAudio(id, true));
  value(await f.api.transcription.start(id));
  await until(() => f.store.get(id).status === 'transcribed');
  const meeting = f.store.get(id);
  assert.equal(meeting.retainAudio, true);
  assert.equal(meeting.hasAudio, true);
  assert.ok(existsSync(path));
});

test('a failed transcription keeps the only audio for retry, and the retry then cleans up', async (t) => {
  let attempt = 0;
  const f = fixture(t, { sidecar: () => (++attempt === 1 ? crashes() : succeeds()) });
  const { id, path } = f.captured();
  value(await f.api.transcription.start(id));
  await until(() => f.store.get(id).status === 'failed');
  assert.ok(existsSync(path));
  assert.equal(f.store.get(id).hasAudio, true);
  assert.equal(f.retention.release(id), false);

  value(await f.api.transcription.start(id));
  await until(() => f.store.get(id).status === 'transcribed');
  assert.equal(existsSync(path), false);
  assert.equal(f.store.get(id).hasAudio, false);
});

test('turning retention off after transcription cleans up immediately; turning it on never restores audio', async (t) => {
  const f = fixture(t);
  const { id, path } = f.transcribed();
  // 先模拟用户当时选择了保留：直接构造「已转写、仍有音频、retain=1」。
  f.store.setRetainAudio(id, true);
  assert.ok(existsSync(path));

  const cleaned = value(await f.api.meetings.setRetainAudio(id, false));
  assert.equal(cleaned.hasAudio, false);
  assert.equal(cleaned.retainAudio, false);
  assert.equal(existsSync(path), false);
  assert.equal(f.events.at(-1).hasAudio, false);

  const again = value(await f.api.meetings.setRetainAudio(id, true));
  assert.equal(again.retainAudio, true);
  assert.equal(again.hasAudio, false);
});

test('captured and failed meetings are never released, even when sweep runs over them', (t) => {
  const f = fixture(t);
  const captured = f.captured('Captured');
  const failed = f.captured('Failed');
  const job = f.store.beginTranscription(failed.id);
  f.store.failJob(job.id, 'TRANSCRIBE_FAILED');
  f.retention.sweep();
  assert.ok(existsSync(captured.path));
  assert.ok(existsSync(failed.path));
  assert.equal(f.store.get(captured.id).hasAudio, true);
  assert.equal(f.store.get(failed.id).hasAudio, true);
});

test('startup recovery converges leftovers from before the policy existed and keeps retained audio', async (t) => {
  const f = fixture(t);
  const stale = f.transcribed('Stale');
  const retained = f.transcribed('Retained');
  f.store.setRetainAudio(retained.id, true);
  await f.services.recover();
  assert.equal(existsSync(stale.path), false);
  assert.equal(f.store.get(stale.id).hasAudio, false);
  assert.ok(existsSync(retained.path));
  assert.equal(f.store.get(retained.id).hasAudio, true);
});

test('interruption between file deletion and reference removal converges on retry', (t) => {
  const f = fixture(t);
  const { id, path } = f.transcribed();
  // 进程在 unlink 之后、清引用之前中断：文件已不存在，引用仍在。
  unlinkSync(path);
  assert.equal(f.store.get(id).hasAudio, true);
  assert.equal(f.retention.release(id), true);
  assert.equal(f.store.get(id).hasAudio, false);
  assert.equal(f.retention.release(id), false);
});

test('a filesystem failure keeps the reference and the transcript, logs a safe code, and a later sweep recovers', (t) => {
  const logged = [];
  const logger = { error: (...args) => logged.push(args) };
  const f = fixture(t, { logger });
  const { id, path } = f.transcribed();
  // 把文件换成目录：unlink 失败且不是 ENOENT。
  unlinkSync(path);
  mkdirSync(path);

  assert.throws(() => f.retention.release(id), errorCode('WRITE_FAILED'));
  assert.equal(f.retention.tryRelease(id), false);
  assert.equal(f.store.get(id).hasAudio, true);
  assert.equal(f.store.get(id).status, 'transcribed');
  assert.deepEqual(f.store.getSegments(id), SEGMENTS);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].slice(0, 3), ['main', 'audio_cleanup_failed', 'WRITE_FAILED']);

  rmSync(path, { recursive: true });
  f.retention.sweep();
  assert.equal(f.store.get(id).hasAudio, false);
});

test('a database failure after the file is gone leaves a reference that the next release removes', (t) => {
  const f = fixture(t);
  const { id } = f.transcribed();
  const original = f.store.removeAudioReference.bind(f.store);
  f.store.removeAudioReference = () => {
    throw new Error('injected database failure');
  };
  assert.equal(f.retention.tryRelease(id), false);
  assert.equal(f.store.get(id).hasAudio, true);
  f.store.removeAudioReference = original;
  assert.equal(f.retention.tryRelease(id), true);
  assert.equal(f.store.get(id).hasAudio, false);
});

test('a generating or ready meeting is released the same way; deleted meetings are ignored', (t) => {
  const f = fixture(t);
  const ready = f.transcribed('Ready');
  const generation = f.store.beginGeneration(ready.id);
  f.store.completeGeneration(generation.id, NOTE);
  assert.equal(f.store.get(ready.id).status, 'ready');
  assert.equal(f.retention.release(ready.id), true);

  const gone = f.transcribed('Gone');
  f.store.markDeleted(gone.id);
  assert.equal(f.retention.tryRelease(gone.id), false);
  assert.ok(existsSync(gone.path));
});

test('removeManagedFile only deletes inside the managed directory and treats a missing file as done', (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'user-original.wav');
  writeFileSync(outside, 'user data');
  assert.throws(() => removeManagedFile(f.audioDirectory, outside), errorCode('WRITE_FAILED'));
  assert.ok(existsSync(outside));

  const inside = join(f.audioDirectory, 'managed.wav');
  writeFileSync(inside, 'managed');
  removeManagedFile(f.audioDirectory, inside);
  assert.equal(existsSync(inside), false);
  assert.doesNotThrow(() => removeManagedFile(f.audioDirectory, inside));
});
