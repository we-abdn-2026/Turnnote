import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockApi } from '../out/tests/runtime.mjs';

const NOTE = {
  summary: 'Reviewed',
  keyTopics: [],
  decisions: [],
  openQuestions: [],
  actionItems: [],
};
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
function until(api, id, status) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Did not reach ${status}`));
    }, 2000);
    const done = (meeting) => {
      if (meeting.id === id && meeting.status === status) {
        clearTimeout(timer);
        unsubscribe();
        resolve(meeting);
      }
    };
    const unsubscribe = api.events.onMeetingUpdated(done);
    void api.meetings.get(id).then((result) => {
      if (result.ok) done(result.value);
    });
  });
}

test('mock stop returns captured, then asynchronous transcription emits progress with job identity', async () => {
  const api = createMockApi({ delayMs: 1, seed: false });
  const id = value(await api.meetings.create('New meeting')).id;
  const states = [];
  const progress = [];
  const unsubscribe = api.events.onMeetingUpdated((meeting) => states.push(meeting.status));
  const unsubscribeProgress = api.events.onJobProgress((event) => progress.push(event));
  const jobId = value(await api.recording.start(id)).activeJobId;
  value(await api.recording.appendChunk(id, jobId, new Int16Array(16000)));
  assert.equal(value(await api.recording.stop(id, jobId)).status, 'captured');
  assert.equal(value(await api.meetings.get(id)).status, 'captured');
  await until(api, id, 'transcribed');
  unsubscribe();
  unsubscribeProgress();
  assert.deepEqual(states, ['recording', 'captured', 'transcribing', 'transcribed']);
  assert.deepEqual(
    progress.map((p) => p.percent),
    [0, 25, 50, 75, 100],
  );
  assert.equal(new Set(progress.map((p) => p.jobId)).size, 1);
  assert.equal(progress[0].kind, 'transcribing');
  assert.equal(value(await api.meetings.get(id)).hasAudio, false);
  assert.equal(value(await api.transcription.getSegments(id)).length, 4);
});

test('mock recording failure retains audio; explicit cancellation clears it before a new recording', async () => {
  const api = createMockApi({ seed: false });
  const id = value(await api.meetings.create('Capture')).id;
  const jobId = value(await api.recording.start(id)).activeJobId;
  const failed = value(await api.recording.fail(id, jobId, 'DEVICE_NOT_FOUND'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError.kind, 'recording');
  assert.equal(failed.hasAudio, true);
  assert.equal((await api.transcription.start(id)).error.code, 'INVALID_STATE');
  assert.equal((await api.recording.start(id)).error.code, 'INVALID_STATE');
  const cancelled = value(await api.recording.cancel(id, failed.lastError.jobId));
  assert.equal(cancelled.status, 'created');
  assert.equal(cancelled.hasAudio, false);
  const newJobId = value(await api.recording.start(id)).activeJobId;
  value(await api.recording.cancel(id, newJobId));
});

test('mock cancellation followed immediately by retry prevents old run from completing the new job', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const id = value(await api.meetings.importAudio()).id;
  const first = value(await api.transcription.start(id));
  assert.equal(first.status, 'transcribing');
  const progress = [];
  api.events.onJobProgress((p) => progress.push(p));
  value(await api.transcription.cancel(id, first.activeJobId));
  value(await api.transcription.start(id));
  await until(api, id, 'transcribed');
  assert.equal(progress.length, 5);
  assert.equal(new Set(progress.map((p) => p.jobId)).size, 1);
  assert.equal(progress[0].jobId, 'mock-job-2');
});

test('mock deletion from a progress callback invalidates the run before any partial transcript persists', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const id = value(await api.meetings.importAudio()).id;
  const deleted = new Promise((resolve) =>
    api.events.onMeetingUpdated((m) => {
      if (m.id === id && m.status === 'deleted') resolve();
    }),
  );
  const progress = [];
  api.events.onJobProgress((p) => {
    progress.push(p);
    if (p.percent === 25) void api.meetings.delete(id);
  });
  value(await api.transcription.start(id));
  await deleted;
  assert.deepEqual(
    progress.map((p) => p.percent),
    [0, 25],
  );
  assert.equal((await api.meetings.get(id)).error.code, 'NOT_FOUND');
  assert.equal((await api.transcription.getSegments(id)).error.code, 'NOT_FOUND');
});

test('mock failure/retry obeys stage boundaries and preserves transcript and user note', async () => {
  const api = createMockApi({ seed: false, delayMs: 1, generationError: 'DEEPSEEK_TIMEOUT' });
  const id = value(await api.meetings.importAudio()).id;
  value(await api.transcription.start(id));
  await until(api, id, 'transcribed');
  value(await api.notes.saveEdit(id, NOTE, 0));
  value(await api.settings.setApiKey('test-key'));
  value(await api.notes.generate(id));
  const failed = await until(api, id, 'failed');
  assert.equal(failed.lastError.kind, 'generating');
  assert.equal((await api.transcription.start(id)).error.code, 'INVALID_STATE');
  assert.deepEqual(value(await api.notes.getLatest(id)).note, NOTE);
  assert.equal(value(await api.transcription.getSegments(id)).length, 4);
  value(await api.notes.generate(id));
  await until(api, id, 'failed');
  assert.equal(value(await api.notes.getLatest(id)).version, 1);
});

test('mock edits use optimistic versions and generation cannot overwrite an edit made while processing', async () => {
  const api = createMockApi({ delayMs: 1 });
  const id = value(await api.meetings.list())[0].id;
  value(await api.settings.setApiKey('test-key'));
  value(await api.notes.generate(id));
  value(await api.notes.saveEdit(id, NOTE, 1));
  assert.equal(
    (await api.notes.saveEdit(id, { ...NOTE, summary: 'Stale' }, 1)).error.code,
    'CONFLICT',
  );
  const failed = await until(api, id, 'failed');
  assert.equal(failed.lastError.code, 'CONFLICT');
  assert.deepEqual(value(await api.notes.getLatest(id)).note, NOTE);
  assert.equal(value(await api.notes.getLatest(id)).version, 2);
  value(await api.meetings.setKeywords(id, ['Budget', 'Budget']));
  value(await api.notes.generate(id));
  await until(api, id, 'ready');
  assert.ok(value(await api.notes.getLatest(id)).note.keyTopics.includes('Budget'));
});

test('mock data and events are isolated snapshots; same shared input validation protects every method', async () => {
  const api = createMockApi();
  const id = value(await api.meetings.list())[0].id;
  const meeting = value(await api.meetings.get(id));
  meeting.keywords.push('mutated');
  assert.equal(value(await api.meetings.get(id)).keywords.includes('mutated'), false);
  const note = value(await api.notes.getLatest(id));
  note.note.summary = 'Mutated';
  assert.notEqual(value(await api.notes.getLatest(id)).note.summary, 'Mutated');
  const settings = value(await api.settings.get());
  settings.deepseekModel = 'Mutated';
  assert.notEqual(value(await api.settings.get()).deepseekModel, 'Mutated');
  api.events.onMeetingUpdated((m) => {
    m.title = 'Observer mutation';
    throw new Error('listener');
  });
  const observed = [];
  const off = api.events.onMeetingUpdated((m) => observed.push(m.title));
  value(await api.meetings.rename(id, 'Renamed'));
  off();
  value(await api.meetings.rename(id, 'After unsubscribe'));
  assert.deepEqual(observed, ['Renamed']);
  assert.equal(value(await api.meetings.get(id)).title, 'After unsubscribe');
  assert.equal((await api.settings.update({ apiKey: 'secret' })).error.code, 'INVALID_INPUT');
  assert.equal(
    (await api.notes.saveEdit(id, { ...NOTE, invalid: true }, 1)).error.code,
    'INVALID_INPUT',
  );
  assert.equal((await api.meetings.create(null)).error.code, 'INVALID_INPUT');
});

test('mock start response remains a committed snapshot when a listener deletes the meeting immediately', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const id = value(await api.meetings.create('Immediate deletion')).id;
  let duringDelete;
  api.events.onMeetingUpdated((meeting) => {
    if (meeting.status === 'recording') void api.meetings.delete(id);
    if (meeting.status === 'deleted') duringDelete = api.meetings.get(id);
  });
  const started = value(await api.recording.start(id));
  assert.equal(started.status, 'recording');
  assert.ok(started.activeJobId);
  assert.equal((await api.meetings.get(id)).error.code, 'NOT_FOUND');
  assert.equal((await duringDelete).error.code, 'NOT_FOUND');
});

test('stale recording controls and PCM chunks cannot write to or stop a new capture session', async () => {
  const api = createMockApi({ seed: false });
  const id = value(await api.meetings.create('Recording tokens')).id;
  const old = value(await api.recording.start(id)).activeJobId;
  value(await api.recording.cancel(id, old));
  const current = value(await api.recording.start(id)).activeJobId;
  for (const result of [
    await api.recording.appendChunk(id, old, new Int16Array(16000)),
    await api.recording.stop(id, old),
    await api.recording.fail(id, old, 'CAPTURE_FAILED'),
    await api.recording.cancel(id, old),
  ])
    assert.equal(result.error.code, 'INVALID_STATE');
  assert.equal(value(await api.meetings.get(id)).activeJobId, current);
  value(await api.recording.appendChunk(id, current, new Int16Array(16000)));
  value(await api.recording.cancel(id, current));
});
