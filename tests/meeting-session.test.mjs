import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUEST_FAILED_MESSAGE,
  availableActions,
  createMeetingSession,
  createMockApi,
  createMockRecording,
  isRecording,
} from '../out/tests/runtime.mjs';

/** 记录会话每次通知时的会议状态 */
function observe(session) {
  const statuses = [];
  session.subscribe(() => {
    const status = session.getState().meeting?.status;
    if (status && statuses.at(-1) !== status) statuses.push(status);
  });
  return statuses;
}

function until(session, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 2000);
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function withEvents(api) {
  const meetingListeners = new Set();
  const progressListeners = new Set();
  const offMeeting = api.events.onMeetingUpdated((meeting) => {
    for (const listener of meetingListeners) listener(meeting);
  });
  const offProgress = api.events.onJobProgress((progress) => {
    for (const listener of progressListeners) listener(progress);
  });
  return {
    api: {
      ...api,
      events: {
        onMeetingUpdated(listener) {
          meetingListeners.add(listener);
          return () => meetingListeners.delete(listener);
        },
        onJobProgress(listener) {
          progressListeners.add(listener);
          return () => progressListeners.delete(listener);
        },
      },
    },
    emitMeeting(meeting) {
      for (const listener of meetingListeners) listener(meeting);
    },
    emitProgress(progress) {
      for (const listener of progressListeners) listener(progress);
    },
    dispose() {
      offMeeting();
      offProgress();
    },
  };
}

test('create → start → stop: state follows Main snapshots and events through transcribed', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  const statuses = observe(session);

  assert.equal(await session.create('Weekly sync'), true);
  const { meeting } = session.getState();
  assert.match(meeting.id, /^mock-/);
  assert.equal((await api.meetings.get(meeting.id)).value.status, 'created');

  assert.equal(await session.start(), true);
  assert.equal(session.getState().meeting.status, 'recording');
  assert.ok(session.getState().meeting.activeJobId);

  assert.equal(await session.stop(), true);
  await until(session, (s) => s.meeting.status === 'transcribed');
  disconnect();
  assert.deepEqual(statuses, ['created', 'recording', 'captured', 'transcribing', 'transcribed']);
  assert.equal(session.getState().error, null);
});

test('events for other meetings never change the current meeting', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Mine');
  const mine = session.getState().meeting;

  const other = (await api.meetings.create('Other')).value;
  const job = (await api.recording.start(other.id)).value.activeJobId;
  await api.recording.fail(other.id, job, 'CAPTURE_FAILED');
  await api.meetings.rename(other.id, 'Renamed other');

  assert.deepEqual(session.getState().meeting, mine);
  assert.equal(session.getState().error, null);
  disconnect();
});

test('job progress is scoped to the active meeting and job, monotonic, and cleared at completion', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  const events = withEvents(base);
  const session = createMeetingSession(events.api, createMockRecording(events.api));
  const disconnect = session.connect();
  await session.create('Progress');
  const created = session.getState().meeting;
  const startedAt = Date.parse(created.updatedAt) + 1000;
  const active = {
    ...created,
    status: 'transcribing',
    activeJobId: 'job-current',
    updatedAt: new Date(startedAt).toISOString(),
  };
  events.emitMeeting(active);
  events.emitProgress({
    meetingId: 'other-meeting',
    jobId: 'job-current',
    kind: 'transcribing',
    percent: 80,
  });
  events.emitProgress({
    meetingId: created.id,
    jobId: 'old-job',
    kind: 'transcribing',
    percent: 80,
  });
  events.emitProgress({
    meetingId: created.id,
    jobId: 'job-current',
    kind: 'generating',
    percent: 80,
  });
  assert.equal(session.getState().jobProgress, null);

  events.emitProgress({
    meetingId: created.id,
    jobId: 'job-current',
    kind: 'transcribing',
    percent: 25,
  });
  events.emitProgress({
    meetingId: created.id,
    jobId: 'job-current',
    kind: 'transcribing',
    percent: 10,
  });
  assert.equal(session.getState().jobProgress.percent, 25);

  events.emitMeeting({
    ...active,
    status: 'transcribed',
    activeJobId: null,
    updatedAt: new Date(startedAt + 1000).toISOString(),
  });
  assert.equal(session.getState().jobProgress, null);
  events.emitProgress({
    meetingId: created.id,
    jobId: 'job-current',
    kind: 'transcribing',
    percent: 100,
  });
  events.emitMeeting(active);
  assert.equal(session.getState().meeting.status, 'transcribed');
  assert.equal(session.getState().jobProgress, null);
  await session.create('Next meeting');
  events.emitProgress({
    meetingId: created.id,
    jobId: 'job-current',
    kind: 'transcribing',
    percent: 50,
  });
  assert.equal(session.getState().meeting.title, 'Next meeting');
  assert.equal(session.getState().jobProgress, null);
  const nextMeeting = session.getState().meeting;
  const generationAt = Date.parse(nextMeeting.updatedAt) + 1000;
  const generating = {
    ...nextMeeting,
    status: 'generating',
    activeJobId: 'generation-current',
    updatedAt: new Date(generationAt).toISOString(),
  };
  events.emitMeeting(generating);
  events.emitProgress({
    meetingId: nextMeeting.id,
    jobId: 'generation-current',
    kind: 'generating',
    percent: 40,
  });
  assert.equal(session.getState().jobProgress.percent, 40);
  events.emitMeeting({
    ...generating,
    status: 'failed',
    activeJobId: null,
    lastError: {
      kind: 'generating',
      jobId: 'generation-current',
      code: 'DEEPSEEK_UNAVAILABLE',
      message: 'DeepSeek is unavailable.',
    },
    updatedAt: new Date(generationAt + 1000).toISOString(),
  });
  assert.equal(session.getState().meeting.status, 'failed');
  assert.equal(session.getState().jobProgress, null);
  events.emitMeeting(generating);
  assert.equal(session.getState().meeting.status, 'failed');
  disconnect();
  events.dispose();
});

test('transcription cancellation is exposed as a saved recording and ignores the cancelled job', async () => {
  const events = withEvents(createMockApi({ seed: false, delayMs: 1 }));
  const session = createMeetingSession(events.api, createMockRecording(events.api));
  const disconnect = session.connect();
  await session.create('Cancelled transcription');
  const created = session.getState().meeting;
  const startedAt = Date.parse(created.updatedAt) + 1000;
  events.emitMeeting({
    ...created,
    status: 'transcribing',
    activeJobId: 'cancelled-job',
    updatedAt: new Date(startedAt).toISOString(),
  });
  events.emitMeeting({
    ...created,
    status: 'captured',
    activeJobId: null,
    updatedAt: new Date(startedAt + 1000).toISOString(),
  });
  assert.equal(session.getState().cancelledKind, 'transcribing');
  events.emitProgress({
    meetingId: created.id,
    jobId: 'cancelled-job',
    kind: 'transcribing',
    percent: 100,
  });
  events.emitMeeting({
    ...created,
    status: 'transcribing',
    activeJobId: 'cancelled-job',
    updatedAt: new Date(startedAt + 2000).toISOString(),
  });
  assert.equal(session.getState().meeting.status, 'captured');
  assert.equal(session.getState().jobProgress, null);
  disconnect();
  events.dispose();
});

test('switching to a new meeting ignores late events from the previous one', async () => {
  const api = createMockApi({ seed: false, delayMs: 5 });
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('First');
  const first = session.getState().meeting.id;
  await session.start();
  await session.stop();
  await session.create('Second');
  const second = session.getState().meeting;
  // 第一场会议此后的转写进度和完成事件不能影响第二场
  for (let i = 0; (await api.meetings.get(first)).value.status !== 'transcribed'; i++) {
    assert.ok(i < 200, 'first meeting reaches transcribed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(session.getState().meeting.id, second.id);
  assert.equal(session.getState().meeting.status, 'created');
  disconnect();
});

test('creating another meeting is refused while recording, so the recording keeps its stop control', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  let creates = 0;
  const api = {
    ...base,
    meetings: { ...base.meetings, create: (title) => (creates++, base.meetings.create(title)) },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Recording');
  await session.start();
  const recording = session.getState().meeting;
  assert.equal(isRecording(session.getState()), true);
  assert.equal(availableActions(session.getState()).create, false);
  assert.equal(await session.create('Second'), false);
  assert.equal(creates, 1);
  assert.equal(session.getState().meeting.id, recording.id);
  assert.equal(availableActions(session.getState()).stop, true);

  assert.equal(await session.stop(), true);
  assert.equal(isRecording(session.getState()), false);
  assert.equal(await session.create('Second'), true);
  disconnect();
});

test('a recording event that arrives before the start response already blocks create', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  let release;
  const api = {
    ...base,
    recording: {
      ...base.recording,
      start: async (id) => {
        const result = await base.recording.start(id);
        await new Promise((resolve) => (release = resolve));
        return result;
      },
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Event first');
  const starting = session.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.getState().meeting.status, 'recording');
  release();
  await starting;
  // 响应结束 pending 后仍处于录音中，新建仍不可用
  assert.equal(session.getState().pending, null);
  assert.equal(availableActions(session.getState()).create, false);
  disconnect();
});

test('disconnect unsubscribes and drops the response of an in-flight request', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  const gate = deferred();
  const api = {
    ...base,
    recording: {
      ...base.recording,
      start: async (id) => {
        await gate.promise;
        return base.recording.start(id);
      },
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Unmount');
  const created = session.getState().meeting;
  const starting = session.start();
  assert.equal(session.getState().pending, 'start');
  disconnect();
  assert.equal(session.getState().pending, null);

  let notified = 0;
  session.subscribe(() => notified++);
  gate.resolve();
  assert.equal(await starting, false);
  await base.meetings.rename(created.id, 'After unmount');
  assert.equal(notified, 0);
  assert.equal(session.getState().meeting.status, 'created');
});

test('reconnecting refreshes the snapshot missed while disconnected', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api, createMockRecording(api));
  session.connect()();
  const first = session.connect();
  await session.create('Remount');
  const id = session.getState().meeting.id;
  first();
  await api.meetings.rename(id, 'Renamed while away');
  const second = session.connect();
  await until(session, (s) => s.meeting.title === 'Renamed while away');
  second();
});

test('duplicate start/stop while a request is pending sends only one request', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  const calls = { start: 0, stop: 0 };
  const api = {
    ...base,
    recording: {
      ...base.recording,
      start: (id) => (calls.start++, base.recording.start(id)),
      stop: (id, job) => (calls.stop++, base.recording.stop(id, job)),
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Double click');
  assert.deepEqual(await Promise.all([session.start(), session.start()]), [true, false]);
  assert.equal(await session.start(), false); // recording 状态下不可再次启动
  assert.deepEqual(await Promise.all([session.stop(), session.stop()]), [true, false]);
  assert.equal(await session.stop(), false);
  assert.deepEqual(calls, { start: 1, stop: 1 });
  disconnect();
});

test('a response older than events received while it was pending does not overwrite them', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  let stale;
  const api = {
    ...base,
    recording: {
      ...base.recording,
      // stop 响应在后续 transcribing 事件之后才到达
      stop: async (id, job) => {
        stale = await base.recording.stop(id, job);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return stale;
      },
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Ordering');
  await session.start();
  await session.stop();
  assert.equal(stale.value.status, 'captured');
  assert.notEqual(session.getState().meeting.status, 'captured');
  disconnect();
});

test('failed Result and rejection report a safe error and keep the last confirmed meeting', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  let mode = 'result';
  const api = {
    ...base,
    recording: {
      ...base.recording,
      start: async () => {
        if (mode === 'reject') throw new Error('ipc closed at /private/path');
        return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Not available yet.' } };
      },
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Errors');
  const { meeting: created, revision } = session.getState();

  assert.equal(await session.start(), false);
  assert.deepEqual(session.getState(), {
    meeting: created,
    pending: null,
    error: 'Not available yet.',
    warning: null,
    captureStopped: false,
    jobProgress: null,
    cancelledKind: null,
    revision,
  });
  mode = 'reject';
  assert.equal(await session.start(), false);
  assert.equal(session.getState().error, REQUEST_FAILED_MESSAGE);
  assert.deepEqual(session.getState().meeting, created);
  disconnect();
});

test('invalid title is rejected by the shared schema and no meeting is selected', async () => {
  const api = createMockApi({ seed: false });
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  assert.equal(await session.create('   '), false);
  assert.equal(session.getState().meeting, null);
  assert.ok(session.getState().error);
  disconnect();
});

test('failed recording can be discarded and recorded again', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Retry capture');
  await session.start();
  const { id, activeJobId } = session.getState().meeting;
  await api.recording.fail(id, activeJobId, 'DEVICE_NOT_FOUND');
  assert.equal(session.getState().meeting.status, 'failed');
  assert.deepEqual(availableActions(session.getState()), {
    create: true,
    start: false,
    stop: false,
    discard: true,
  });
  assert.equal(await session.discard(), true);
  assert.equal(session.getState().meeting.status, 'created');
  assert.equal(await session.start(), true);
  disconnect();
});

test('available actions follow meeting status; processing states are never startable or stoppable', () => {
  const meeting = (status, extra = {}) => ({
    id: 'm',
    status,
    hasAudio: status !== 'created',
    activeJobId: null,
    lastError: null,
    ...extra,
  });
  const actions = (m, pending = null) => availableActions({ meeting: m, pending, error: null });
  assert.deepEqual(actions(null), { create: true, start: false, stop: false, discard: false });
  assert.equal(actions(meeting('created')).start, true);
  assert.equal(actions(meeting('recording', { activeJobId: 'j' })).stop, true);
  assert.equal(actions(meeting('recording', { activeJobId: 'j' })).create, false);
  for (const status of ['captured', 'transcribing', 'transcribed', 'generating', 'ready']) {
    const a = actions(meeting(status, { activeJobId: 'j' }));
    assert.equal(a.start, false, status);
    assert.equal(a.stop, false, status);
    assert.equal(a.discard, false, status);
    // 已不在录音中，可以新建会议
    assert.equal(a.create, true, status);
  }
  assert.deepEqual(actions(meeting('created'), 'create'), {
    create: false,
    start: false,
    stop: false,
    discard: false,
  });
});
