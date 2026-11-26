/**
 * 继续录音 / 追加录音的前端行为：会话、录音条视图和浏览器 mock，与 Main 的语义保持一致。
 * Main 侧的真实存储、转写和保留策略见 tests/recording-parts.test.mjs。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAddRecording,
  createMeetingLibrary,
  createMeetingSession,
  createMockApi,
  createMockRecording,
  deriveRecordingControls,
} from '../out/tests/runtime.mjs';

const view = (session) => deriveRecordingControls(session.getState(), null);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function until(session, predicate, label = 'state') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Did not reach ${label}`)), 3000);
    const check = () => {
      if (predicate(session.getState())) {
        clearTimeout(timer);
        off();
        resolve();
      }
    };
    const off = session.subscribe(check);
    check();
  });
}

async function connected(options = {}) {
  const api = createMockApi({ seed: false, delayMs: 1, ...options });
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await api.settings.setApiKey('deepseek', 'test-key');
  await session.create('Resumable');
  return { api, session, disconnect };
}

/** 录一段，等会议落定在 transcribed 或 ready，并且这一段的转写片段已经加载进会话 */
async function recordPart(session) {
  const before = session.getState().transcriptSegments.length;
  assert.equal(await session.start(), true);
  await until(session, (s) => s.meeting?.status === 'recording', 'recording');
  assert.equal(await session.stop(), true);
  await until(
    session,
    (s) =>
      ['transcribed', 'ready'].includes(s.meeting?.status) &&
      s.pending === null &&
      s.transcriptState === 'ready' &&
      s.transcriptSegments.length > before,
    'settled after the part, transcript grown',
  );
}

/** 生成纪要，等会议 ready 且该版本的纪要已经加载 */
async function generateNote(session, version) {
  assert.equal(await session.generate(), true);
  await until(
    session,
    (s) =>
      s.meeting?.status === 'ready' &&
      s.pending === null &&
      s.noteState === 'ready' &&
      s.note?.version === version,
    `note version ${version}`,
  );
}

test('the start control is "start" for a fresh meeting and "continue" once it has recorded', async () => {
  const { session, disconnect } = await connected();
  const fresh = view(session);
  assert.deepEqual(
    [fresh.start.visible, fresh.start.enabled, fresh.start.resume],
    [true, true, false],
  );

  await recordPart(session);
  const settled = view(session);
  assert.deepEqual(
    [settled.start.visible, settled.start.enabled, settled.start.resume],
    [true, true, true],
  );
  assert.equal(settled.hint, null);

  assert.equal(await session.start(), true);
  await until(session, (s) => s.meeting?.status === 'recording', 'recording again');
  const live = view(session);
  assert.equal(live.start.visible, false, 'no second start while recording');
  assert.equal(live.stop.visible, true);
  assert.equal(live.indicator, 'recording');
  await session.stop();
  disconnect();
});

test('a second recording extends the transcript after the first and marks the note stale', async () => {
  const { api, session, disconnect } = await connected();
  await recordPart(session);
  const first = session.getState().transcriptSegments;
  const firstEnd = first.at(-1).endMs;

  await generateNote(session, 1);
  assert.equal(session.getState().meeting.noteStale, false);
  const note = session.getState().note;

  await recordPart(session);
  const state = session.getState();
  assert.equal(state.meeting.status, 'ready');
  assert.equal(state.meeting.noteStale, true);
  assert.deepEqual(state.note, note, 'the existing note is untouched');
  const all = state.transcriptSegments;
  assert.equal(all.length, first.length * 2);
  assert.deepEqual(all.slice(0, first.length), first);
  assert.ok(all[first.length].startMs > firstEnd, 'the new part comes after the old content');
  const starts = all.map((segment) => segment.startMs);
  assert.deepEqual(
    starts,
    [...starts].sort((a, b) => a - b),
  );

  // 会议库里能看到"待更新"；重新生成后消失
  assert.equal((await api.meetings.list()).value[0].noteStale, true);
  await generateNote(session, 2);
  assert.equal(session.getState().meeting.noteStale, false);
  assert.equal((await api.meetings.list()).value[0].noteStale, false);
  disconnect();
});

test('discarding a failed extra recording returns to the earlier state and keeps transcript and note', async () => {
  const { api, session, disconnect } = await connected();
  await recordPart(session);
  await generateNote(session, 1);
  const segments = session.getState().transcriptSegments;
  const note = session.getState().note;

  assert.equal(await session.start(), true);
  await until(session, (s) => s.meeting?.status === 'recording', 'recording');
  const { meeting } = session.getState();
  // 采集失败：Main 把这一段标成失败
  await api.recording.fail(meeting.id, meeting.activeJobId, 'CAPTURE_FAILED');
  await until(session, (s) => s.meeting?.status === 'failed', 'failed');
  const failed = view(session);
  assert.equal(failed.discard.visible, true);
  assert.equal(failed.start.visible, false, 'the failed part must be discarded first');

  assert.equal(await session.discard(), true);
  await until(session, (s) => s.meeting?.status === 'ready' && s.pending === null, 'back to ready');
  const state = session.getState();
  assert.equal(state.meeting.noteStale, false);
  assert.deepEqual(state.transcriptSegments, segments);
  assert.deepEqual(state.note, note);
  assert.equal(view(session).start.resume, true);
  disconnect();
});

test('discarding the only recording of a fresh meeting still returns to created', async () => {
  const { api, session, disconnect } = await connected();
  await session.start();
  await until(session, (s) => s.meeting?.status === 'recording', 'recording');
  const { meeting } = session.getState();
  await api.recording.fail(meeting.id, meeting.activeJobId, 'CAPTURE_FAILED');
  await until(session, (s) => s.meeting?.status === 'failed', 'failed');
  assert.equal(await session.discard(), true);
  await until(session, (s) => s.meeting?.status === 'created' && s.pending === null, 'created');
  assert.equal(view(session).start.resume, false);
  disconnect();
});

test('while transcribing or generating the user is told why recording is unavailable', async () => {
  const { api, session, disconnect } = await connected({ delayMs: 25 });
  assert.equal(await session.start(), true);
  await until(session, (s) => s.meeting?.status === 'recording', 'recording');
  await session.stop();
  await until(session, (s) => s.meeting?.status === 'transcribing', 'transcribing');
  const busy = view(session);
  assert.deepEqual([busy.start.visible, busy.start.enabled], [true, false]);
  assert.equal(busy.hint, '正在转写，完成后可以继续录音');
  assert.equal(
    (await api.recording.start(session.getState().meeting.id)).error.code,
    'INVALID_STATE',
  );

  await until(
    session,
    (s) =>
      s.meeting?.status === 'transcribed' && s.pending === null && s.transcriptSegments.length > 0,
    'transcribed with the transcript loaded',
  );
  assert.equal(view(session).hint, null);
  const generating = session.generate();
  await until(session, (s) => s.meeting?.status === 'generating', 'generating');
  assert.equal(view(session).hint, '正在生成纪要，完成后可以继续录音');
  assert.equal(view(session).start.enabled, false);
  await generating;
  disconnect();
});

test('a meeting with no note can be extended freely, and its note state is never stale', async () => {
  const { session, disconnect } = await connected();
  await recordPart(session);
  await recordPart(session);
  const state = session.getState();
  assert.equal(state.meeting.noteStale, false);
  assert.equal(state.meeting.status, 'transcribed');
  assert.equal(state.transcriptSegments.length, 8);
  disconnect();
});

test('the library follows the stale flag from list refreshes', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api, createMockRecording(api));
  const library = createMeetingLibrary(api);
  const disconnect = session.connect();
  library.connect((listener) => session.watchMeetings(listener));
  await api.settings.setApiKey('deepseek', 'k');
  await session.create('Library');
  await recordPart(session);
  await generateNote(session, 1);
  await recordPart(session);
  for (let i = 0; i < 200 && !library.getState().items[0]?.noteStale; i++) await delay(5);
  assert.equal(library.getState().items[0].noteStale, true);
  disconnect();
});

test('shared lifecycle rule: which states accept another recording', () => {
  const meeting = (status, lastError = null) => ({
    status,
    lastError,
    hasAudio: true,
    activeJobId: null,
  });
  for (const status of ['created', 'captured', 'transcribed', 'ready']) {
    assert.equal(canAddRecording(meeting(status)), true, status);
  }
  for (const status of ['recording', 'transcribing', 'generating', 'deleted']) {
    assert.equal(canAddRecording(meeting(status)), false, status);
  }
  const failed = (kind) => meeting('failed', { kind, jobId: 'j', code: 'INTERNAL', message: '' });
  assert.equal(canAddRecording(failed('recording')), false);
  assert.equal(canAddRecording(failed('transcribing')), true);
  assert.equal(canAddRecording(failed('generating')), true);
});
