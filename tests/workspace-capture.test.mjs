import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import { JSDOM } from 'jsdom';
import { captureEnvironment } from './support/capture-environment.mjs';
import {
  App,
  MeetingStore,
  createCaptureRecording,
  createMeetingSession,
  createStorageHandlers,
  createRecordingHandlers,
  createDispatcher,
  createInvokeApi,
  deriveRecordingControls,
  availableActions,
  isRecording,
} from '../out/tests/runtime.mjs';

function backend(t, mediaOptions = {}) {
  const env = captureEnvironment(t, mediaOptions);
  const directory = mkdtempSync(join(tmpdir(), 'turnnote-workspace-capture-'));
  const store = new MeetingStore(join(directory, 'db.sqlite'), directory);
  const listeners = new Set();
  const emit = (meeting) => {
    for (const listener of listeners) listener(meeting);
  };
  const recording = createRecordingHandlers(store, directory, emit, () => ({
    microphone: 'granted',
    screen: 'granted',
  }));
  const dispatcher = createDispatcher({
    ...createStorageHandlers(store, directory, emit),
    ...recording.handlers,
  });
  const api = {
    ...createInvokeApi((channel, ...args) => dispatcher(channel, args)),
    loopback: env.api.loopback,
    events: {
      onMeetingUpdated(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onJobProgress() {
        return () => {};
      },
    },
  };
  t.after(async () => {
    await recording.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { env, api, store, listeners, recording, databasePath: join(directory, 'db.sqlite') };
}

async function connected(t, options) {
  const fixture = backend(t, options);
  const session = createMeetingSession(fixture.api, createCaptureRecording(fixture.api));
  const disconnect = session.connect();
  t.after(disconnect);
  await session.create('Real capture');
  return { ...fixture, session, disconnect };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for state');
}

test('production App saves selected PCM and offers an honest retry after a commit rollback', async (t) => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'http://localhost' });
  const { document } = dom.window;
  let root;
  let act;
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    dom.window.close();
  });
  for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key],
    });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const { api, store, env, listeners, databasePath } = backend(t);
  dom.window.turnnote = api;
  const react = await import('react');
  act = react.act;
  const { createElement, StrictMode } = react;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.getElementById('root'));
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const click = async (label) => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    assert.ok(button, label);
    assert.equal(button.disabled, false);
    await act(async () => button.click());
    await settle();
  };
  await act(async () => root.render(createElement(StrictMode, null, createElement(App))));
  await settle();
  assert.equal(listeners.size, 1);
  assert.equal(document.querySelectorAll('.recording-controls').length, 0);
  const input = document.querySelector('#meeting-title');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(
      input,
      'Named meeting',
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await click('新建会议');
  // Save through the real selector, rather than injecting capture options.
  await act(async () => {
    const select = document.querySelector('#microphone-select');
    select.value = 'usb-mic';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await settle();
  if ((await api.settings.get()).value.includeSystemAudio) {
    await act(async () => document.querySelector('#system-audio-toggle').click());
    await settle();
  }
  assert.equal((await api.settings.get()).value.microphoneDeviceId, 'usb-mic');
  await click('开始录音');
  assert.deepEqual(env.mediaCalls, []); // consent must precede media access
  await click('已告知，开始录音');
  assert.equal(document.querySelector('.meeting-status').textContent, '录音中');
  assert.deepEqual(
    env.mediaCalls.map(([source]) => source),
    ['microphone'],
  );
  assert.equal(env.mediaCalls[0][1].audio.deviceId.exact, 'usb-mic');
  assert.equal(document.querySelectorAll('.recording-controls').length, 1);
  const meeting = store.list()[0];
  await click('停止录音');
  assert.equal(document.querySelector('.meeting-status').textContent, '录音已保存');
  assert.equal(store.list().length, 1);
  assert.equal(store.get(meeting.id).title, 'Named meeting');
  const wav = readFileSync(store.getAudio(meeting.id).filePath);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [11, 22, 33]);
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.equal(env.context().state, 'closed');

  // Exercise the retry through visible controls in the actual desktop App.
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(
      input,
      'Retry save',
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await click('新建会议');
  await click('开始录音');
  await click('已告知，开始录音');
  const retryId = store.list().find((item) => item.title === 'Retry save').id;
  const db = new Database(databasePath);
  try {
    db.exec(
      "CREATE TRIGGER reject_capture BEFORE UPDATE OF status ON meetings WHEN NEW.status = 'captured' BEGIN SELECT RAISE(ABORT, 'injected capture rollback'); END;",
    );
    await click('停止录音');
    assert.equal(document.querySelector('.meeting-status').textContent, '录音已结束，等待保存');
    assert.equal(document.querySelector('.recording-indicator'), null);
    assert.equal(document.querySelector('#meeting-title').disabled, true);
    const path = store.getAudio(retryId).filePath;
    const saved = readFileSync(path);
    db.exec('DROP TRIGGER reject_capture');
    await click('重试保存');
    assert.equal(document.querySelector('.meeting-status').textContent, '录音已保存');
    assert.deepEqual(readFileSync(path), saved);
    assert.equal(document.querySelector('#meeting-title').disabled, false);
  } finally {
    db.close();
  }
});

test('default microphone setting is captured; system denial remains a visible warning', async (t) => {
  const { api, env, session } = await connected(t, { systemDenied: true });
  await api.settings.update({ microphoneDeviceId: null, includeSystemAudio: true });
  assert.equal(await session.start(), true);
  assert.equal(env.mediaCalls[1][1].audio.deviceId.exact, 'default');
  assert.match(session.getState().warning, /microphone only/);
  assert.equal(await session.stop(), true);
});

test('settings failure prevents Main start and media access, and rejection stays safe', async (t) => {
  const { api, env, store } = backend(t);
  let reject = false;
  const broken = {
    ...api,
    settings: {
      ...api.settings,
      get: async () => {
        if (reject) throw new Error('/private/settings');
        return { ok: false, error: { code: 'INTERNAL', message: 'Settings unavailable.' } };
      },
    },
  };
  const session = createMeetingSession(broken, createCaptureRecording(broken));
  t.after(session.connect());
  await session.create('Settings failure');
  assert.equal(await session.start(), false);
  assert.equal(session.getState().error, 'Settings unavailable.');
  reject = true;
  assert.equal(await session.start(), false);
  assert.equal(session.getState().error, '操作失败，请重试。');
  assert.equal(store.list()[0].status, 'created');
  assert.deepEqual(env.mediaCalls, []);
});

test('capture failure can be discarded then recorded again with current settings', async (t) => {
  const { api, env, store, session } = await connected(t);
  await api.settings.update({ includeSystemAudio: false });
  assert.equal(await session.start(), true);
  env.worklet().onprocessorerror();
  await until(() => session.getState().meeting.status === 'failed');
  assert.equal(await session.discard(), true);
  assert.equal(store.getAudio(session.getState().meeting.id), null);
  await api.settings.update({ microphoneDeviceId: 'usb-mic' });
  assert.equal(await session.start(), true);
  assert.equal(env.mediaCalls.at(-1)[1].audio.deviceId.exact, 'usb-mic');
  assert.equal(await session.stop(), true);
});

test('microphone permission failure keeps a discardable Main job and safe error', async (t) => {
  const { session } = await connected(t, { micDenied: true });
  assert.equal(await session.start(), false);
  assert.equal(session.getState().meeting.status, 'failed');
  assert.equal(session.getState().error, 'Audio capture permission was denied.');
  assert.equal(await session.discard(), true);
  assert.equal(session.getState().meeting.status, 'created');
});

test('unmount during media initialization releases late tracks and discards the pending job', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { api, env, store, session, disconnect } = await connected(t, { duringMic: () => gate });
  await api.settings.update({ includeSystemAudio: false });
  const starting = session.start();
  await until(() => env.mediaCalls.length > 0);
  disconnect();
  release();
  assert.equal(await starting, false);
  assert.equal(store.list()[0].status, 'created');
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.equal(env.context().state, 'closed');
});

test('unmount during active recording flushes and saves audio without leaking media', async (t) => {
  const { api, env, store, session, disconnect } = await connected(t);
  await api.settings.update({ includeSystemAudio: false });
  await session.start();
  disconnect();
  await until(() => store.list()[0].status === 'captured');
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.equal(readFileSync(store.getAudio(store.list()[0].id).filePath).readUInt32LE(40), 6);
});

test('enabled system source is requested along with the persisted microphone', async (t) => {
  const { api, env, session } = await connected(t);
  await api.settings.update({ microphoneDeviceId: 'usb-mic', includeSystemAudio: true });
  assert.equal(await session.start(), true);
  assert.deepEqual(
    env.mediaCalls.map(([source]) => source),
    ['system', 'microphone'],
  );
  assert.equal(env.mediaCalls[1][1].audio.deviceId.exact, 'usb-mic');
  assert.equal(session.getState().warning, null);
  assert.equal(await session.stop(), true);
});

test('failed initialization in a new meeting never discards an older failed capture', async (t) => {
  const { api, env, store, session } = await connected(t);
  await api.settings.update({ includeSystemAudio: false });
  await session.start();
  const firstId = session.getState().meeting.id;
  env.worklet().onprocessorerror();
  await until(() => session.getState().meeting.status === 'failed');
  await session.create('Second');
  const secondId = session.getState().meeting.id;
  globalThis.navigator.mediaDevices.getUserMedia = async () => {
    throw new DOMException('denied', 'NotAllowedError');
  };
  assert.equal(await session.start(), false);
  assert.equal(await session.discard(), true);
  assert.equal(store.get(secondId).status, 'created');
  assert.equal(store.get(firstId).status, 'failed');
  assert.ok(store.getAudio(firstId));
});

test('disconnect while loading settings does not start a job after the response arrives', async (t) => {
  const { api, env, store } = backend(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const delayed = {
    ...api,
    settings: {
      ...api.settings,
      get: async () => {
        await gate;
        return api.settings.get();
      },
    },
  };
  const session = createMeetingSession(delayed, createCaptureRecording(delayed));
  const disconnect = session.connect();
  await session.create('Unmount settings');
  const starting = session.start();
  disconnect();
  release();
  assert.equal(await starting, false);
  assert.equal(store.list()[0].status, 'created');
  assert.deepEqual(env.mediaCalls, []);
});

test('same workspace retries failed unlink, then records the same meeting again', async (t) => {
  const { api, env, store, session } = await connected(t);
  await api.settings.update({ includeSystemAudio: false });
  await session.start();
  const id = session.getState().meeting.id;
  env.worklet().onprocessorerror();
  await until(() => session.getState().meeting.status === 'failed');
  const path = store.getAudio(id).filePath;
  const original = fs.unlinkSync;
  const mocked = t.mock.method(fs, 'unlinkSync', (target) => {
    if (target === path) throw Object.assign(new Error('injected unlink'), { code: 'EBUSY' });
    return original(target);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await session.discard(), false);
    assert.equal(availableActions(session.getState()).discard, true);
    assert.ok(fs.existsSync(path));
    assert.equal(session.getState().meeting.status, 'failed');
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await session.discard(), true);
  assert.equal(store.getAudio(id), null);
  assert.equal(fs.existsSync(path), false);
  assert.equal(await session.start(), true);
  assert.equal(session.getState().meeting.id, id);
  assert.equal(await session.stop(), true);
  assert.equal(store.get(id).status, 'captured');
});

test('workspace retries SQLite stop rollback without deleting or rewriting saved WAV', async (t) => {
  const { api, env, store, session, databasePath } = await connected(t);
  await api.settings.update({ includeSystemAudio: false });
  await session.start();
  const { id, activeJobId: jobId } = session.getState().meeting;
  const db = new Database(databasePath);
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER reject_capture BEFORE UPDATE OF status ON meetings WHEN NEW.status = 'captured' BEGIN SELECT RAISE(ABORT, 'injected capture rollback'); END;",
  );
  assert.equal(await session.stop(), false);
  const path = store.getAudio(id).filePath;
  const saved = readFileSync(path);
  assert.equal(saved.readUInt32LE(40), 6);
  assert.equal(env.context().state, 'closed');
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.equal(isRecording(session.getState()), false);
  assert.equal(deriveRecordingControls(session.getState(), null).indicator, 'saving');
  assert.equal(availableActions(session.getState()).stop, true);
  assert.equal(availableActions(session.getState()).create, false);
  // A late chunk cannot append to a finalized writer or turn a save into a capture failure.
  assert.equal(
    (await api.recording.appendChunk(id, jobId, new Int16Array([99]))).error.code,
    'INVALID_STATE',
  );
  assert.equal(store.get(id).status, 'recording');
  db.exec('DROP TRIGGER reject_capture');
  assert.equal(await session.stop(), true);
  assert.equal(store.get(id).status, 'captured');
  assert.deepEqual(readFileSync(path), saved);
  assert.equal(availableActions(session.getState()).create, true);
  assert.equal(env.calls.filter((call) => call === 'close-context').length, 1);
});

for (const terminal of ['fail', 'shutdown']) {
  test(`${terminal} retries a rolled-back SQLite terminal after the WAV is closed`, async (t) => {
    const { api, env, store, session, recording, databasePath } = await connected(t);
    await api.settings.update({ includeSystemAudio: false });
    await session.start();
    env.worklet().port.onmessage({ data: { chunk: new Int16Array([42, 43]) } });
    await until(
      () => fs.statSync(store.getAudio(session.getState().meeting.id).filePath).size === 48,
    );
    const { id, activeJobId: jobId } = session.getState().meeting;
    const db = new Database(databasePath);
    t.after(() => db.close());
    db.exec(
      "CREATE TRIGGER reject_failure BEFORE UPDATE OF status ON meetings WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'injected failure rollback'); END;",
    );
    if (terminal === 'fail') {
      assert.equal((await api.recording.fail(id, jobId, 'CAPTURE_FAILED')).error.code, 'INTERNAL');
    } else {
      await assert.rejects(recording.shutdown(), /injected failure rollback/);
    }
    const path = store.getAudio(id).filePath;
    const saved = readFileSync(path);
    assert.equal(store.get(id).status, 'recording');
    db.exec('DROP TRIGGER reject_failure');
    if (terminal === 'fail') {
      assert.equal((await api.recording.fail(id, jobId, 'CAPTURE_FAILED')).ok, true);
    } else {
      await recording.shutdown();
    }
    assert.equal(store.get(id).status, 'failed');
    assert.deepEqual(readFileSync(path), saved);
    assert.equal((await api.recording.cancel(id, jobId)).ok, true);
  });
}

test('shutdown coordinates a finalized WAV whose captured commit failed', async (t) => {
  const { store, session, recording, databasePath } = await connected(t);
  await session.start();
  const id = session.getState().meeting.id;
  const db = new Database(databasePath);
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER reject_capture BEFORE UPDATE OF status ON meetings WHEN NEW.status = 'captured' BEGIN SELECT RAISE(ABORT, 'injected capture rollback'); END;",
  );
  assert.equal(await session.stop(), false);
  const path = store.getAudio(id).filePath;
  const saved = readFileSync(path);
  await recording.shutdown();
  assert.equal(store.get(id).status, 'failed');
  assert.equal(store.get(id).lastError.code, 'INTERRUPTED');
  assert.deepEqual(readFileSync(path), saved);
});

test('discard retries SQLite rollback after unlink already succeeded', async (t) => {
  const { api, env, store, session, databasePath } = await connected(t);
  await api.settings.update({ includeSystemAudio: false });
  await session.start();
  env.worklet().onprocessorerror();
  await until(() => session.getState().meeting.status === 'failed');
  const id = session.getState().meeting.id;
  const path = store.getAudio(id).filePath;
  const db = new Database(databasePath);
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER reject_discard BEFORE UPDATE OF status ON meetings WHEN NEW.status = 'created' BEGIN SELECT RAISE(ABORT, 'injected discard rollback'); END;",
  );
  assert.equal(await session.discard(), false);
  assert.equal(fs.existsSync(path), false);
  assert.ok(store.getAudio(id));
  db.exec('DROP TRIGGER reject_discard');
  assert.equal(await session.discard(), true);
  assert.equal(store.getAudio(id), null);
  assert.equal(store.get(id).status, 'created');
  assert.equal(await session.start(), true);
  assert.equal(await session.stop(), true);
});

test('processor failure with a rolled-back Main report can settle after database recovery', async (t) => {
  const { api, env, store, session, databasePath } = await connected(t);
  await api.settings.update({ includeSystemAudio: false });
  await session.start();
  const id = session.getState().meeting.id;
  const db = new Database(databasePath);
  t.after(() => db.close());
  db.exec(
    "CREATE TRIGGER reject_failure BEFORE UPDATE OF status ON meetings WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'injected failure rollback'); END;",
  );
  env.worklet().onprocessorerror();
  await until(() => session.getState().error !== null);
  assert.equal(store.get(id).status, 'recording');
  assert.equal(env.context().state, 'closed');
  assert.equal(isRecording(session.getState()), false);
  db.exec('DROP TRIGGER reject_failure');
  assert.equal(await session.stop(), false); // cannot save a capture that failed
  assert.equal(store.get(id).status, 'failed');
  assert.equal(store.get(id).lastError.code, 'CAPTURE_FAILED');
  assert.equal(await session.discard(), true);
});
