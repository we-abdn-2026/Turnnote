import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeConfirmation,
  createMeetingSession,
  createMockApi,
  createMockRecording,
  deriveRecordingControls,
} from '../out/tests/runtime.mjs';

const view = (session, confirming = null) =>
  deriveRecordingControls(session.getState(), confirming);
const visible = (v) =>
  ['start', 'stop', 'discard'].filter((name) => v[name].visible && v[name].enabled);

function until(session, status) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Did not reach ${status}`)), 2000);
    const check = () => {
      if (session.getState().meeting?.status === status) {
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
  await session.create('Controls');
  return { api, session, disconnect };
}

test('start requires the consent step; the prompt shows only while start is available', async () => {
  const { session, disconnect } = await connected();
  const idle = view(session);
  assert.equal(idle.indicator, 'idle');
  assert.deepEqual(visible(idle), ['start']);
  assert.equal(idle.showConsent, false);

  const prompting = view(session, 'start');
  assert.equal(prompting.showConsent, true);
  // 提醒打开时，开始按钮本身不可用，只能通过提醒确认
  assert.equal(prompting.start.enabled, false);

  await session.start();
  assert.equal(view(session, 'start').showConsent, false);
  disconnect();
});

test('recording shows a persistent indicator and only the stop control', async () => {
  const { session, disconnect } = await connected();
  await session.start();
  const v = view(session);
  assert.equal(v.indicator, 'recording');
  assert.deepEqual(visible(v), ['stop']);
  assert.equal(v.start.visible, false);
  disconnect();
});

test('captured, transcribing and generating are processing, never shown as recording', async () => {
  const { api, session, disconnect } = await connected();
  const seen = new Map();
  session.subscribe(() => {
    const { status } = session.getState().meeting;
    seen.set(status, view(session));
  });
  await session.start();
  await session.stop();
  await until(session, 'transcribed');
  await api.settings.setApiKey('deepseek', 'test-key');
  await api.notes.generate(session.getState().meeting.id);
  await until(session, 'ready');
  for (const status of ['captured', 'transcribing', 'generating']) {
    const v = seen.get(status);
    assert.ok(v, `saw ${status}`);
    assert.equal(v.indicator, 'processing', status);
    assert.equal(v.stop.visible, false, status);
    assert.equal(v.discard.visible, false, status);
  }
  // 转写和生成进行中：能看到"继续录音"，但不可用，并说明原因
  for (const status of ['transcribing', 'generating']) {
    const v = seen.get(status);
    assert.equal(v.start.visible, true, status);
    assert.equal(v.start.enabled, false, status);
    assert.match(v.hint, /完成后可以继续录音/, status);
  }
  // 落定之后：可以继续录音，按钮是"继续"而不是"开始"
  for (const status of ['transcribed', 'ready']) {
    const v = seen.get(status);
    assert.equal(v.indicator, 'done', status);
    assert.equal(v.start.visible, true, status);
    assert.equal(v.start.resume, true, status);
    assert.equal(v.hint, null, status);
  }
  disconnect();
});

test('while start or stop is pending the control stays visible, busy and disabled', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  const gates = [];
  const gated =
    (fn) =>
    (...args) =>
      new Promise((resolve) => gates.push(() => resolve(fn(...args))));
  const api = {
    ...base,
    recording: {
      ...base.recording,
      start: gated(base.recording.start),
      stop: gated(base.recording.stop),
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Pending');

  const starting = session.start();
  assert.deepEqual(view(session).start, {
    visible: true,
    enabled: false,
    busy: true,
    resume: false,
  });
  assert.equal(await session.start(), false);
  gates.shift()();
  await starting;

  const stopping = session.stop();
  assert.deepEqual(view(session).stop, { visible: true, enabled: false, busy: true });
  assert.equal(view(session).indicator, 'recording');
  gates.shift()();
  await stopping;
  assert.equal(gates.length, 0);
  disconnect();
});

test('start failure keeps the meeting startable and leaves the error to the workspace', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  const api = {
    ...base,
    recording: {
      ...base.recording,
      start: async () => ({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'Audio capture permission was denied.' },
      }),
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Denied');
  assert.equal(await session.start(), false);
  assert.equal(session.getState().error, '录音权限被拒绝。请在系统设置中允许 Turnnote 录音。');
  const v = view(session);
  assert.equal(v.indicator, 'idle');
  assert.deepEqual(visible(v), ['start']);
  disconnect();
});

test('when the captured event arrives before the stop response, stop disappears immediately', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  let release;
  const api = {
    ...base,
    recording: {
      ...base.recording,
      // Main 已提交并发布 captured 事件，响应稍后才到达
      stop: async (id, job) => {
        const result = await base.recording.stop(id, job);
        await new Promise((resolve) => (release = resolve));
        return result;
      },
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Event first');
  await session.start();
  const stopping = session.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.getState().pending, 'stop');
  // mock 的自动转写可能已把 captured 推进到 transcribing，两者都是处理中
  assert.ok(['captured', 'transcribing'].includes(session.getState().meeting.status));
  const v = view(session);
  assert.equal(v.indicator, 'processing');
  assert.equal(v.stop.visible, false);
  // 处理中不能再开始新的一段：即使按钮可见，也不可用
  assert.equal(v.start.enabled, false);
  release();
  await stopping;
  disconnect();
});

test('stop failure keeps showing recording so the user can retry stop', async () => {
  const base = createMockApi({ seed: false, delayMs: 1 });
  let failStop = true;
  const api = {
    ...base,
    recording: {
      ...base.recording,
      stop: async (id, job) =>
        failStop
          ? { ok: false, error: { code: 'WRITE_FAILED', message: 'Write failed.' } }
          : base.recording.stop(id, job),
    },
  };
  const session = createMeetingSession(api, createMockRecording(api));
  const disconnect = session.connect();
  await session.create('Stop retry');
  await session.start();
  assert.equal(await session.stop(), false);
  assert.equal(view(session).indicator, 'recording');
  assert.deepEqual(visible(view(session)), ['stop']);
  failStop = false;
  assert.equal(await session.stop(), true);
  assert.equal(view(session).indicator, 'processing');
  disconnect();
});

test('capture failure offers discard with confirmation, then recording can start again', async () => {
  const { api, session, disconnect } = await connected();
  await session.start();
  const { id, activeJobId } = session.getState().meeting;
  await api.recording.fail(id, activeJobId, 'DEVICE_NOT_FOUND');
  const failed = view(session);
  assert.equal(failed.indicator, 'failed');
  assert.deepEqual(visible(failed), ['discard']);
  assert.equal(view(session, 'discard').showDiscardConfirm, true);
  assert.equal(view(session, 'discard').discard.enabled, false);

  assert.equal(await session.discard(), true);
  const reset = view(session);
  assert.equal(reset.indicator, 'idle');
  assert.deepEqual(visible(reset), ['start']);
  disconnect();
});

test('a failed transcription offers no stop or discard, but the user can keep recording', async () => {
  const { session, disconnect } = await connected({ transcriptionError: 'TRANSCRIBE_FAILED' });
  await session.start();
  await session.stop();
  await until(session, 'failed');
  const v = view(session);
  assert.equal(session.getState().meeting.lastError.kind, 'transcribing');
  assert.equal(v.indicator, 'failed');
  assert.deepEqual(visible(v), ['start']);
  assert.equal(v.start.resume, true);
  assert.equal(v.stop.visible, false);
  assert.equal(v.discard.visible, false);
  disconnect();
});

test('a confirmation opened for one snapshot never reappears after the meeting changes', async () => {
  const { api, session, disconnect } = await connected();
  const opened = {
    action: 'start',
    revision: session.getState().revision,
    attempt: session.getState().attempt,
  };
  assert.equal(activeConfirmation(opened, session.getState()), 'start');

  // 打开提醒后会议失败，再丢弃回到 created：提醒不能自行弹出。
  // mock 的多次更新可能落在同一毫秒，updatedAt 相同也必须失效
  await session.start();
  const { id, activeJobId } = session.getState().meeting;
  await api.recording.fail(id, activeJobId, 'CAPTURE_FAILED');
  await session.discard();
  const later = session.getState();
  assert.equal(later.meeting.status, 'created');
  assert.equal(activeConfirmation(opened, later), null);
  assert.equal(view(session, activeConfirmation(opened, later)).showConsent, false);
  assert.equal(activeConfirmation(null, later), null);
  disconnect();
});

test('a confirmation never carries over to a newly created meeting', async () => {
  const { session, disconnect } = await connected();
  const opened = {
    action: 'start',
    revision: session.getState().revision,
    attempt: session.getState().attempt,
  };
  await session.create('Next meeting');
  assert.equal(activeConfirmation(opened, session.getState()), null);
  disconnect();
});

test('no meeting selected shows no indicator and no recording controls', () => {
  const state = { meeting: null, pending: null, error: null, revision: 0, attempt: 0 };
  assert.equal(activeConfirmation({ action: 'start', revision: 0, attempt: 0 }, state), null);
  const v = deriveRecordingControls(state, 'start');
  assert.equal(v.indicator, 'none');
  assert.equal(v.showConsent, false);
  assert.deepEqual(visible(v), []);
});
