import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUEST_FAILED_MESSAGE,
  availableActions,
  createMeetingSession,
  createMockApi,
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

test('create → start → stop: state follows Main snapshots and events through transcribed', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api);
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
  const session = createMeetingSession(api);
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

test('switching to a new meeting ignores late events from the previous one', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api);
  const disconnect = session.connect();
  await session.create('First');
  const first = session.getState().meeting.id;
  await session.start();
  await session.create('Second');
  const second = session.getState().meeting;
  // 第一场会议此后的停止和转写事件不能影响第二场
  const jobId = (await api.meetings.get(first)).value.activeJobId;
  await api.recording.stop(first, jobId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.getState().meeting.id, second.id);
  assert.equal(session.getState().meeting.status, 'created');
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
  const session = createMeetingSession(api);
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
  const session = createMeetingSession(api);
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
  const session = createMeetingSession(api);
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
  const session = createMeetingSession(api);
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
  const session = createMeetingSession(api);
  const disconnect = session.connect();
  await session.create('Errors');
  const { meeting: created, revision } = session.getState();

  assert.equal(await session.start(), false);
  assert.deepEqual(session.getState(), {
    meeting: created,
    pending: null,
    error: 'Not available yet.',
    revision,
  });
  mode = 'reject';
  assert.equal(await session.start(), false);
  assert.equal(session.getState().error, REQUEST_FAILED_MESSAGE);
  assert.deepEqual(session.getState().meeting, created);
  disconnect();
});

test('invalid title is rejected by the shared schema and no meeting is selected', async () => {
  const session = createMeetingSession(createMockApi({ seed: false }));
  const disconnect = session.connect();
  assert.equal(await session.create('   '), false);
  assert.equal(session.getState().meeting, null);
  assert.ok(session.getState().error);
  disconnect();
});

test('failed recording can be discarded and recorded again', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  const session = createMeetingSession(api);
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
  for (const status of ['captured', 'transcribing', 'transcribed', 'generating', 'ready']) {
    const a = actions(meeting(status, { activeJobId: 'j' }));
    assert.equal(a.start, false, status);
    assert.equal(a.stop, false, status);
    assert.equal(a.discard, false, status);
  }
  assert.deepEqual(actions(meeting('created'), 'create'), {
    create: false,
    start: false,
    stop: false,
    discard: false,
  });
});
