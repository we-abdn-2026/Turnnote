// #30 #31 #33 #34 #45 #86：会议库、打开/删除/重命名、纪要编辑、导出、重新转写的会话层与数据层。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPORTED_MESSAGE,
  createMeetingLibrary,
  createMeetingSession,
  createMockApi,
  createMockRecording,
  createRecordingClock,
  describeCode,
  describeError,
  errorMessages,
  formatTimecode,
  meetingActions,
  segmentIndexAt,
} from '../out/tests/runtime.mjs';

function until(session, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeout);
    const check = () => {
      if (predicate(session.getState())) {
        clearTimeout(timer);
        off();
        resolve(session.getState());
      }
    };
    const off = session.subscribe(check);
    check();
  });
}

function setup(options = {}) {
  const api = createMockApi({ seed: false, delayMs: 1, ...options });
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  return { api, session, disconnect };
}

async function transcribed(session, title = 'Transcribed') {
  await session.create(title);
  await session.start();
  await session.stop();
  return until(
    session,
    (state) => state.meeting.status === 'transcribed' && state.transcriptState === 'ready',
  );
}

test('every error code has Chinese copy and unknown errors fall back safely', () => {
  for (const code of Object.keys(errorMessages)) {
    assert.match(describeCode(code), /[一-鿿]/, code);
  }
  assert.equal(describeError(null), '操作失败，请重试。');
  assert.equal(
    describeError({ code: 'FUTURE_CODE', message: 'Safe main text.' }),
    'Safe main text.',
  );
});

test('timecodes are fixed width and cues resolve exact or containing segments', () => {
  assert.equal(formatTimecode(0), '00:00:00');
  assert.equal(formatTimecode(3_601_999), '01:00:01');
  const segments = [
    { startMs: 0, endMs: 2400, text: 'a' },
    { startMs: 2400, endMs: 5200, text: 'b' },
  ];
  assert.equal(segmentIndexAt(segments, 2400), 1);
  assert.equal(segmentIndexAt(segments, 3000), 1);
  assert.equal(segmentIndexAt(segments, 9000), -1);
});

test('open switches to an existing meeting, clears old content first, and is refused while recording', async () => {
  const { api, session, disconnect } = setup();
  const first = (await transcribed(session, 'First')).meeting.id;
  await session.create('Second');
  assert.equal(session.getState().transcriptSegments.length, 0);

  assert.equal(await session.open(first), true);
  assert.equal(session.getState().meeting.title, 'First');
  await until(session, (state) => state.transcriptSegments.length === 4);

  await session.create('Recording');
  await session.start();
  assert.equal(meetingActions(session.getState()).open, false);
  assert.equal(await session.open(first), false);
  assert.equal(session.getState().meeting.title, 'Recording');
  await session.stop();
  assert.equal((await api.meetings.get(first)).value.title, 'First');
  disconnect();
});

test('open failure keeps the current meeting and reports a safe error', async () => {
  const { session, disconnect } = setup();
  await session.create('Current');
  assert.equal(await session.open('missing-id'), false);
  assert.equal(session.getState().meeting.title, 'Current');
  assert.equal(session.getState().error, describeCode('NOT_FOUND'));
  disconnect();
});

test('rename, retain audio and keywords update the meeting through Main snapshots', async () => {
  const { api, session, disconnect } = setup();
  await session.create('Draft title');
  const id = session.getState().meeting.id;
  assert.equal(await session.rename('Final title'), true);
  assert.equal(await session.setRetainAudio(true), true);
  assert.equal(await session.saveKeywords(['定价', 'Launch']), true);
  const stored = (await api.meetings.get(id)).value;
  assert.equal(stored.title, 'Final title');
  assert.equal(stored.retainAudio, true);
  assert.deepEqual(stored.keywords, ['定价', 'Launch']);
  assert.deepEqual(session.getState().meeting.keywords, ['定价', 'Launch']);
  // 共享 schema 拒绝空标题，界面保留原标题
  assert.equal(await session.rename('   '), false);
  assert.equal(session.getState().meeting.title, 'Final title');
  disconnect();
});

test('delete clears the workspace; a deletion from elsewhere keeps the snapshot until closed', async () => {
  const { api, session, disconnect } = setup();
  await session.create('Delete me');
  const id = session.getState().meeting.id;
  assert.equal(await session.delete(), true);
  assert.equal(session.getState().meeting, null);
  assert.equal((await api.meetings.get(id)).ok, false);

  await session.create('Deleted elsewhere');
  const other = session.getState().meeting.id;
  const reads = { segments: 0 };
  const original = api.transcription.getSegments;
  api.transcription.getSegments = async (...args) => {
    reads.segments += 1;
    return original(...args);
  };
  await api.meetings.delete(other);
  await until(session, (state) => state.meeting?.status === 'deleted');
  assert.equal(reads.segments, 0, 'no content reads for a deleted meeting');
  assert.equal(meetingActions(session.getState()).rename, false);
  session.close();
  assert.equal(session.getState().meeting, null);
  disconnect();
});

test('delete is refused while recording', async () => {
  const { session, disconnect } = setup();
  await session.create('Recording');
  await session.start();
  assert.equal(meetingActions(session.getState()).delete, false);
  assert.equal(await session.delete(), false);
  assert.equal(session.getState().meeting.status, 'recording');
  await session.stop();
  disconnect();
});

test('saveNote writes a user version; a stale expected version is a conflict that keeps the draft', async () => {
  const { session, disconnect } = setup();
  await transcribed(session);
  const note = {
    summary: '手动整理的纪要',
    keyTopics: ['定价'],
    decisions: [{ text: 'Ship Friday', timestampMs: 2400 }],
    openQuestions: [],
    actionItems: [{ task: 'Notes', owner: 'unspecified', dueDate: 'unspecified' }],
  };
  const saved = await session.saveNote(note, 0);
  assert.equal(saved.ok, true);
  assert.equal(saved.version.version, 1);
  assert.equal(session.getState().note.source, 'user');
  await until(session, (state) => state.meeting.status === 'ready');

  const conflict = await session.saveNote({ ...note, summary: 'Stale' }, 0);
  assert.deepEqual(conflict, {
    ok: false,
    conflict: true,
    message: describeCode('CONFLICT'),
  });
  assert.equal(session.getState().note.note.summary, '手动整理的纪要');
  disconnect();
});

test('saveNote is refused before a transcript exists', async () => {
  const { session, disconnect } = setup();
  await session.create('Too early');
  const outcome = await session.saveNote(
    { summary: 'x', keyTopics: [], decisions: [], openQuestions: [], actionItems: [] },
    0,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.conflict, false);
  disconnect();
});

test('export reports success only when Main saved the file', async () => {
  const { api, session, disconnect } = setup();
  await transcribed(session);
  assert.equal(meetingActions(session.getState()).export, false);
  await session.saveNote(
    { summary: 'Ready', keyTopics: [], decisions: [], openQuestions: [], actionItems: [] },
    0,
  );
  assert.equal(await session.exportMarkdown(), true);
  assert.equal(session.getState().notice, EXPORTED_MESSAGE);

  api.exports.markdown = async () => ({ ok: true, value: { saved: false } });
  assert.equal(await session.exportMarkdown(), false);
  assert.equal(session.getState().notice, null);
  assert.equal(session.getState().error, null);

  api.exports.markdown = async () => ({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'This feature is not available yet.' },
  });
  assert.equal(await session.exportMarkdown(), false);
  assert.equal(session.getState().error, describeCode('NOT_IMPLEMENTED'));
  disconnect();
});

test('cancelled import keeps the current meeting; a successful import switches to it', async () => {
  const { api, session, disconnect } = setup();
  await session.create('Keep me');
  const original = api.meetings.importAudio;
  api.meetings.importAudio = async () => ({ ok: true, value: null });
  assert.equal(await session.importAudio(), false);
  assert.equal(session.getState().meeting.title, 'Keep me');
  assert.equal(session.getState().pending, null);

  api.meetings.importAudio = original;
  assert.equal(await session.importAudio(), true);
  assert.equal(session.getState().meeting.title, 'Imported audio');
  await until(session, (state) => state.meeting.status === 'transcribed', 4000);
  disconnect();
});

test('transcription can be cancelled and retried from the saved recording', async () => {
  const { session, disconnect } = setup({ delayMs: 20 });
  await session.create('Retry transcription');
  await session.start();
  await session.stop();
  await until(session, (state) => state.meeting.status === 'transcribing');
  assert.equal(meetingActions(session.getState()).cancelTranscription, true);
  assert.equal(await session.cancelTranscription(), true);
  await until(session, (state) => state.meeting.status === 'captured');
  assert.equal(session.getState().cancelledKind, 'transcribing');

  assert.equal(meetingActions(session.getState()).transcribe, true);
  assert.equal(await session.retryTranscription(), true);
  await until(session, (state) => state.meeting.status === 'transcribed', 4000);
  disconnect();
});

test('every guarded action advances attempt, so confirmations opened before it expire', async () => {
  const { api, session, disconnect } = setup();
  const before = session.getState().attempt;
  api.meetings.create = async () => ({
    ok: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'x' },
  });
  assert.equal(await session.create('Fails'), false);
  assert.equal(session.getState().attempt, before + 1);
  disconnect();
});

test('watchMeetings shares the one Main subscription and sees every meeting', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  let subscriptions = 0;
  const counted = {
    ...api,
    events: {
      ...api.events,
      onMeetingUpdated(listener) {
        subscriptions += 1;
        return api.events.onMeetingUpdated(listener);
      },
    },
  };
  const session = createMeetingSession(counted, createMockRecording(counted));
  const disconnect = session.connect();
  const seen = [];
  const unwatch = session.watchMeetings((meeting) => seen.push(meeting.title));
  await api.meetings.create('From another window');
  assert.equal(subscriptions, 1);
  assert.deepEqual(seen, ['From another window']);
  unwatch();
  await api.meetings.create('After unwatch');
  assert.deepEqual(seen, ['From another window']);
  disconnect();
});

test('library loads, refreshes on events, and ignores a slower stale search', async () => {
  const api = createMockApi({ seed: true, delayMs: 1 });
  const listeners = new Set();
  const library = createMeetingLibrary(api);
  const stop = library.connect((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const settled = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 2000);
      const check = () => {
        if (predicate(library.getState())) {
          clearTimeout(timer);
          off();
          resolve(library.getState());
        }
      };
      const off = library.subscribe(check);
      check();
    });

  await settled((state) => state.loadState === 'ready' && state.items.length === 1);
  await api.meetings.create('Planning');
  for (const listener of listeners) listener();
  await settled((state) => state.items.length === 2);

  // 较早的查询慢返回时不能覆盖较新的查询
  const original = api.meetings.list;
  api.meetings.list = async (query) => {
    if (query === 'week') await new Promise((resolve) => setTimeout(resolve, 400));
    return original(query);
  };
  library.search('week');
  await new Promise((resolve) => setTimeout(resolve, 220));
  // 种子会议的转写里有 "launch plan"，用完整标题避免同时命中
  library.search('planning');
  await settled((state) => state.query === 'planning' && state.items.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(
    library.getState().items.map((item) => item.title),
    ['Planning'],
  );

  api.meetings.list = async () => {
    throw new Error('/private/db');
  };
  library.reload();
  const failed = await settled((state) => state.loadState === 'error');
  assert.equal(failed.error, '操作失败，请重试。');
  api.meetings.list = original;
  library.reload();
  await settled((state) => state.loadState === 'ready');
  stop();
  assert.equal(listeners.size, 0);
});

test('recording clock counts one job, freezes when media stops and resets for the next job', () => {
  let now = 1_000;
  let state = { meeting: null, captureStopped: false };
  const listeners = new Set();
  const session = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (next) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const clock = createRecordingClock(session, () => now);
  const stop = clock.connect();
  assert.equal(clock.getSnapshot(), null);

  emit({ meeting: { status: 'recording', activeJobId: 'job-1' }, captureStopped: false });
  assert.equal(clock.getSnapshot(), 0);
  now += 3_400;
  emit({ ...state, captureStopped: true });
  assert.equal(clock.getSnapshot(), 3_400);
  now += 10_000;
  emit({ ...state });
  assert.equal(clock.getSnapshot(), 3_400, 'frozen while saving');

  emit({ meeting: { status: 'captured', activeJobId: null }, captureStopped: false });
  assert.equal(clock.getSnapshot(), null);
  emit({ meeting: { status: 'recording', activeJobId: 'job-2' }, captureStopped: false });
  assert.equal(clock.getSnapshot(), 0);
  stop();
});

test('search shows the matching transcript passage only for meetings whose title did not match', async () => {
  const api = createMockApi({ seed: true, delayMs: 1 });
  const library = createMeetingLibrary(api);
  const stop = library.connect(() => () => {});
  const settled = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 2000);
      const check = () => {
        if (predicate(library.getState())) {
          clearTimeout(timer);
          off();
          resolve(library.getState());
        }
      };
      const off = library.subscribe(check);
      check();
    });
  await settled((state) => state.loadState === 'ready');

  library.search('release notes');
  const found = await settled((state) => state.items[0]?.snippet !== undefined);
  assert.equal(found.items[0].snippet.match, 'release notes');
  assert.match(found.items[0].snippet.before, /prepare the $/);

  // 标题已命中时不再显示片段
  library.search('weekly');
  // 切换查询的瞬间旧片段就被清掉，之后刷新出的标题命中项也没有片段
  assert.equal(library.getState().items[0].snippet, undefined);
  const byTitle = await settled((state) => state.query === 'weekly' && state.items.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(library.getState().items[0].snippet, undefined);
  assert.equal(byTitle.items[0].title, 'Weekly sync');
  stop();
});
