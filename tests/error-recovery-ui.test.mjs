import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
const { document } = window;
for (const key of ['window', 'document', 'navigator'])
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, StrictMode, useSyncExternalStore } = await import('react');
const { createRoot } = await import('react-dom/client');
const {
  ErrorRecoveryAction,
  MeetingWorkspace,
  createMockApi,
  createMockRecording,
  createMeetingSession,
  errorMessages,
} = await import('../out/tests/runtime.mjs');

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('UI condition did not become true');
}
async function mount(t, element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(createElement(StrictMode, null, element)));
  await settle();
  return container;
}
function button(container, text) {
  return [...container.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
}
async function click(element) {
  assert.equal(!!element, true, 'expected button');
  assert.equal(element.disabled, false);
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await settle();
}

async function workspace(t, { generationError, withKey = true } = {}) {
  const base = createMockApi({ delayMs: 1, generationError });
  if (withKey) await base.settings.setApiKey('deepseek', 'sk-test-key');
  let sends = 0;
  let settings = 0;
  const api = {
    ...base,
    notes: {
      ...base.notes,
      generate: (...args) => {
        sends++;
        return base.notes.generate(...args);
      },
    },
  };
  window.turnnote = api;
  const session = createMeetingSession(api, createMockRecording(api));
  const off = session.connect();
  t.after(off);
  const [meeting] = (await api.meetings.list()).value;
  await session.open(meeting.id);
  function View() {
    const state = useSyncExternalStore(session.subscribe, session.getState);
    return createElement(MeetingWorkspace, {
      state,
      session,
      elapsedMs: null,
      drawerOpen: false,
      provider: { label: '测试服务', model: 'model', destination: 'example.com', local: false },
      onDrawer() {},
      onCreateMeeting() {},
      onOpenSettings() {
        settings++;
      },
    });
  }
  const container = await mount(t, createElement(View));
  await until(() => session.getState().noteState === 'ready');
  return { container, session, api, sends: () => sends, settings: () => settings };
}

test('missing credentials lead to settings and never offer an automatic resend', async (t) => {
  const f = await workspace(t, { withKey: false });
  await click(button(f.container, '重新生成会议纪要'));
  await click(button(f.container, '确认发送并重新生成'));
  assert.equal(f.sends(), 1);
  const alert = f.container.querySelector('.workspace-error');
  assert.match(alert.textContent, /API Key/);
  assert.equal(!!button(alert, '重试'), false);
  await click(button(alert, '检查设置'));
  assert.equal(f.settings(), 1);
  assert.equal(f.sends(), 1);
});

test('retrying a persisted timeout still requires send confirmation and preserves existing content', async (t) => {
  const f = await workspace(t, { generationError: 'AI_TIMEOUT' });
  const before = structuredClone(f.session.getState().note);
  const transcript = structuredClone(f.session.getState().transcriptSegments);
  await click(button(f.container, '重新生成会议纪要'));
  assert.equal(f.sends(), 0);
  await click(button(f.container, '确认发送并重新生成'));
  await until(() => f.session.getState().meeting.status === 'failed');
  assert.equal(f.sends(), 1);
  assert.deepEqual(f.session.getState().note, before);
  assert.deepEqual(f.session.getState().transcriptSegments, transcript);
  await click(button(f.container.querySelector('.workspace-error'), '重试'));
  assert.equal(f.sends(), 1, 'opening retry confirmation must not send');
  assert.equal(!!f.container.querySelector('.generation-consent[open]'), true);
  await click(button(f.container.querySelector('.generation-consent'), '取消'));
  assert.equal(f.sends(), 1);
  await click(button(f.container.querySelector('.workspace-error'), '重试'));
  await click(button(f.container, '确认发送并重新生成'));
  assert.equal(f.sends(), 2);
  await until(() => f.session.getState().meeting.status === 'failed');
});

test('persisted authentication errors offer settings rather than retry', async (t) => {
  const f = await workspace(t, { generationError: 'AI_UNAUTHORIZED' });
  await click(button(f.container, '重新生成会议纪要'));
  await click(button(f.container, '确认发送并重新生成'));
  await until(() => f.session.getState().meeting.status === 'failed');
  const alert = f.container.querySelector('.workspace-error');
  assert.equal(!!button(alert, '重试'), false);
  await click(button(alert, '检查设置'));
  assert.equal(f.settings(), 1);
  assert.equal(f.sends(), 1);
});

test('permission recovery uses the existing IPC and keeps failures safe', async (t) => {
  let target;
  let finish;
  window.turnnote = {
    recording: {
      openPermissionSettings: (value) => {
        target = value;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  };
  const container = await mount(
    t,
    createElement(ErrorRecoveryAction, { code: 'PERMISSION_DENIED', onSettings() {} }),
  );
  await click(button(container, '打开录音权限设置'));
  assert.equal(target, 'microphone');
  assert.equal(button(container, '正在打开...').disabled, true);
  await act(async () =>
    finish({ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'sk-secret /private/path' } }),
  );
  assert.equal(
    container.querySelector('[role="alert"]').textContent,
    errorMessages.NOT_IMPLEMENTED,
  );
  assert.doesNotMatch(container.textContent, /secret|private/);
  window.turnnote.recording.openPermissionSettings = async () => {
    throw new Error('sk-secret /private/path');
  };
  await click(button(container, '打开录音权限设置'));
  assert.equal(container.querySelector('[role="alert"]').textContent, '操作失败，请重试。');
});
