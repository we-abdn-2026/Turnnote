// 挂载实际 AudioDeviceSelector，覆盖 #9 要求的 UI 状态与 React 接线；纯状态逻辑见 audio-device-state.test.mjs。
import assert from 'node:assert/strict';
import test from 'node:test';
import { act, click, render, settle, window } from './support/dom.mjs';

// 必须在 dom.mjs 注入 jsdom 全局对象之后再加载
const {
  AudioDeviceSelector,
  ENUMERATE_FAILED_MESSAGE,
  LOAD_FAILED_MESSAGE,
  SAVE_FAILED_MESSAGE,
  createMockApi,
} = await import('../out/tests/runtime.mjs');

const GRANTED = { microphone: 'granted', screen: 'granted' };
const mic = (deviceId, label = '') => ({ deviceId, label, kind: 'audioinput', groupId: 'g' });
const speaker = (deviceId) => ({ deviceId, label: '', kind: 'audiooutput', groupId: 'g' });

/** 共享 mock API，可替换权限查询、settings.get/update，并记录所有写入 */
function apiWith({ permissions = GRANTED, get, update } = {}) {
  const base = createMockApi({ seed: false });
  const writes = [];
  const api = {
    ...base,
    settings: {
      ...base.settings,
      get: get ?? base.settings.get,
      update: async (patch) => {
        writes.push(patch);
        return (update ?? base.settings.update)(patch);
      },
    },
    recording: {
      ...base.recording,
      getPermissions:
        typeof permissions === 'function'
          ? permissions
          : async () => ({ ok: true, value: permissions }),
    },
  };
  const persisted = async () => (await base.settings.get()).value;
  return { api, base, writes, persisted };
}

/** 受控 navigator.mediaDevices：记录枚举次数和 devicechange 监听 */
function fakeMediaDevices(initial) {
  let list = initial;
  const listeners = new Set();
  return {
    calls: 0,
    listeners,
    set(next) {
      list = next;
    },
    async enumerateDevices() {
      this.calls += 1;
      if (list instanceof Error) throw list;
      return list;
    },
    addEventListener(type, listener) {
      if (type === 'devicechange') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'devicechange') listeners.delete(listener);
    },
  };
}

async function mount(t, api, media) {
  window.turnnote = api;
  Object.defineProperty(window.navigator, 'mediaDevices', { value: media, configurable: true });
  const { container, unmount } = await render(t, AudioDeviceSelector);
  const $ = (selector) => container.querySelector(selector);
  return {
    $,
    // 断言失败时 assert 会深度检查 jsdom 元素并长时间挂起，存在性只比较布尔值
    has: (selector) => $(selector) !== null,
    unmount,
    text: () => container.textContent,
    select: () => $('#microphone-select'),
    checkbox: () => $('#system-audio-toggle'),
    options: () => [...$('#microphone-select').options].map((o) => [o.value, o.text, o.disabled]),
  };
}

async function choose(view, value) {
  await act(async () => {
    view.select().value = value;
    view.select().dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle();
}

async function fireDeviceChange(media) {
  await act(async () => {
    for (const listener of media.listeners) listener(new window.Event('devicechange'));
  });
  await settle();
}

test('granted: lists only audio inputs and persists microphone and system audio choices through settings', async (t) => {
  const { api, writes, persisted } = apiWith();
  const media = fakeMediaDevices([mic('mic-a', 'USB Mic'), speaker('spk')]);
  const view = await mount(t, api, media);

  assert.equal(view.select().disabled, false);
  assert.deepEqual(view.options(), [
    ['', '系统默认麦克风', false],
    ['mic-a', 'USB Mic', false],
  ]);
  assert.equal(view.has('.refresh-button'), true);
  assert.equal(view.has('[role="alert"]'), false);
  assert.equal(media.calls, 1);
  // StrictMode 双重执行 effect 后只保留一个监听
  assert.equal(media.listeners.size, 1);

  await choose(view, 'mic-a');
  assert.deepEqual(writes, [{ microphoneDeviceId: 'mic-a' }]);
  assert.equal(view.select().value, 'mic-a');
  assert.equal((await persisted()).microphoneDeviceId, 'mic-a');

  assert.equal(view.checkbox().checked, true);
  assert.match(view.text(), /将混录系统播放的声音/);
  await click(view.checkbox());
  assert.deepEqual(writes.at(-1), { includeSystemAudio: false });
  assert.equal(view.checkbox().checked, false);
  assert.match(view.text(), /只录制麦克风，不包含系统播放的声音/);
  assert.equal((await persisted()).includeSystemAudio, false);

  await choose(view, '');
  assert.deepEqual(writes.at(-1), { microphoneDeviceId: null });
  assert.equal((await persisted()).microphoneDeviceId, null);
  // 选项变化只保存设置，不启动采集
  assert.doesNotMatch(view.text(), /录音中|正在录制/);
});

for (const [microphone, title] of [
  ['denied', '麦克风权限被拒绝'],
  ['not-determined', '需要麦克风权限'],
  ['restricted', '无法访问麦克风'],
  ['unknown', '无法访问麦克风'],
]) {
  test(`${microphone}: shows the permission notice, disables device selection and never enumerates`, async (t) => {
    const { api } = apiWith({ permissions: { microphone, screen: 'granted' } });
    const media = fakeMediaDevices([mic('mic-a', 'USB Mic')]);
    const view = await mount(t, api, media);

    assert.match(view.$('.permission-notice[role="alert"]').textContent, new RegExp(title));
    assert.equal(view.select().disabled, true);
    assert.match(view.text(), /\(需要权限\)/);
    assert.equal(view.has('.refresh-button'), false);
    assert.equal(media.calls, 0);
    assert.equal(media.listeners.size, 0);
    assert.doesNotMatch(view.text(), /未检测到麦克风|当前不可用/);
    // 系统音频开关不依赖麦克风权限
    assert.equal(view.checkbox().disabled, false);
  });
}

test('no devices → devicechange connects one; refresh re-enumerates without leaking listeners; unmount cleans up', async (t) => {
  const { api } = apiWith();
  const media = fakeMediaDevices([]);
  const view = await mount(t, api, media);

  assert.match(
    view.$('.warning[role="status"]').textContent,
    /未检测到麦克风.*请连接麦克风后点击刷新/,
  );
  assert.deepEqual(view.options(), [['', '系统默认麦克风', false]]);
  const callsAfterMount = media.calls;

  media.set([mic('mic-new', 'New Mic')]);
  await fireDeviceChange(media);
  assert.equal(media.calls, callsAfterMount + 1);
  assert.doesNotMatch(view.text(), /未检测到麦克风/);
  assert.deepEqual(view.options().at(-1), ['mic-new', 'New Mic', false]);

  media.set([]);
  await click(view.$('.refresh-button'));
  assert.equal(media.calls, callsAfterMount + 2);
  assert.match(view.text(), /未检测到麦克风/);
  assert.equal(media.listeners.size, 1);

  await view.unmount();
  assert.equal(media.listeners.size, 0);
});

test('browser placeholder devices before microphone access: no duplicate option, no "no devices" warning', async (t) => {
  // 页面尚未获得麦克风授权时，Chrome 的 enumerateDevices 只返回 deviceId 和 label 都为空的占位设备
  const { api } = apiWith();
  const media = fakeMediaDevices([mic(''), speaker(''), { ...mic(''), kind: 'videoinput' }]);
  const view = await mount(t, api, media);

  // 占位设备的空值不能与“系统默认麦克风”重复（React duplicate key 会被 render 的 console.error 断言捕获）
  assert.deepEqual(view.options(), [['', '系统默认麦克风', false]]);
  assert.doesNotMatch(view.text(), /未检测到麦克风/);
  assert.equal(view.select().disabled, false);
});

test('enumeration failure shows a recoverable error instead of "no devices"; refresh recovers', async (t) => {
  const { api } = apiWith();
  const media = fakeMediaDevices(new Error('enumerate failed at /private/path'));
  const view = await mount(t, api, media);

  assert.equal(view.$('.error').textContent, ENUMERATE_FAILED_MESSAGE);
  assert.doesNotMatch(view.text(), /未检测到麦克风|\/private\/path/);

  media.set([mic('mic-a', 'USB Mic')]);
  await click(view.$('.refresh-button'));
  assert.equal(view.has('.error'), false);
  assert.deepEqual(view.options().at(-1), ['mic-a', 'USB Mic', false]);
});

test('removing the selected device keeps it as an unavailable option without rewriting settings; reconnecting restores it', async (t) => {
  const { api, base, writes, persisted } = apiWith();
  await base.settings.update({ microphoneDeviceId: 'mic-old' });
  const media = fakeMediaDevices([mic('mic-old', 'Old Mic'), mic('mic-new', 'New Mic')]);
  const view = await mount(t, api, media);
  assert.equal(view.select().value, 'mic-old');
  assert.doesNotMatch(view.text(), /当前不可用/);

  media.set([mic('mic-new', 'New Mic')]);
  await fireDeviceChange(media);
  assert.equal(view.select().value, 'mic-old');
  assert.deepEqual(view.options(), [
    ['', '系统默认麦克风', false],
    ['mic-old', '已断开的设备（不可用）', true],
    ['mic-new', 'New Mic', false],
  ]);
  assert.match(
    view.$('.warning[role="status"]').textContent,
    /已选择的麦克风当前不可用。请重新连接该设备后点击刷新，或改选其他设备。/,
  );
  assert.deepEqual(writes, []);
  assert.equal((await persisted()).microphoneDeviceId, 'mic-old');

  media.set([mic('mic-old', 'Old Mic'), mic('mic-new', 'New Mic')]);
  await click(view.$('.refresh-button'));
  assert.doesNotMatch(view.text(), /当前不可用/);
  assert.deepEqual(view.options()[1], ['mic-old', 'Old Mic', false]);
  assert.deepEqual(writes, []);
});

const notImplemented = { code: 'NOT_IMPLEMENTED', message: 'Not implemented.' };
const internal = { code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
const rejectQuery = async () => {
  throw new Error('ipc closed at /private/path');
};
for (const [name, target, failQuery, message] of [
  [
    'permissions NOT_IMPLEMENTED Result',
    'permissions',
    async () => ({ ok: false, error: notImplemented }),
    notImplemented.message,
  ],
  [
    'settings failure Result',
    'get',
    async () => ({ ok: false, error: internal }),
    internal.message,
  ],
  ['permissions rejection', 'permissions', rejectQuery, LOAD_FAILED_MESSAGE],
  ['settings rejection', 'get', rejectQuery, LOAD_FAILED_MESSAGE],
]) {
  test(`query ${name}: ends loading with a safe error and retry recovers`, async (t) => {
    let fail = true;
    const healthyGet = createMockApi({ seed: false }).settings.get;
    const { api } = apiWith({
      get: () => (fail && target === 'get' ? failQuery() : healthyGet()),
      permissions: async () =>
        fail && target === 'permissions' ? failQuery() : { ok: true, value: GRANTED },
    });
    const media = fakeMediaDevices([mic('mic-a', 'USB Mic')]);
    const view = await mount(t, api, media);

    assert.doesNotMatch(view.text(), /加载设备设置/);
    const alert = view.$('.error-notice[role="alert"]');
    assert.match(alert.textContent, /加载失败/);
    assert.match(alert.textContent, new RegExp(message.replace('.', '\\.')));
    assert.equal(
      /当前版本尚未提供该功能/.test(alert.textContent),
      message === notImplemented.message,
    );
    assert.doesNotMatch(view.text(), /\/private\/path/);
    // 失败时不显示设备控件，也不把 NOT_IMPLEMENTED 当作已授权去枚举
    assert.equal(view.has('#microphone-select'), false);
    assert.equal(media.calls, 0);

    fail = false;
    await click(view.$('.retry-button'));
    assert.equal(view.has('.error-notice'), false);
    assert.equal(view.select().disabled, false);
    assert.deepEqual(view.options().at(-1), ['mic-a', 'USB Mic', false]);
  });
}

const invalid = { code: 'INVALID_INPUT', message: 'Invalid input.' };
for (const [name, failUpdate, message] of [
  ['failure Result', async () => ({ ok: false, error: invalid }), invalid.message],
  [
    'rejection',
    async () => {
      throw new Error('ipc closed at /private/path');
    },
    SAVE_FAILED_MESSAGE,
  ],
]) {
  test(`save ${name}: both controls report the failure, keep the confirmed value and stay usable`, async (t) => {
    let fail = true;
    const { api, base, writes, persisted } = apiWith({
      update: (patch) => (fail ? failUpdate(patch) : base.settings.update(patch)),
    });
    const media = fakeMediaDevices([mic('mic-a', 'USB Mic')]);
    const view = await mount(t, api, media);

    await choose(view, 'mic-a');
    let alert = view.$('.error-notice[role="alert"]');
    assert.match(alert.textContent, /保存失败/);
    assert.match(alert.textContent, new RegExp(message.replace('.', '\\.')));
    assert.doesNotMatch(view.text(), /\/private\/path/);
    assert.equal(view.select().value, '');
    assert.equal(view.select().disabled, false);

    await click(view.checkbox());
    alert = view.$('.error-notice[role="alert"]');
    assert.match(alert.textContent, /保存失败/);
    assert.equal(view.checkbox().checked, true);
    assert.equal(view.checkbox().disabled, false);
    assert.match(view.text(), /将混录系统播放的声音/);

    assert.deepEqual(writes, [{ microphoneDeviceId: 'mic-a' }, { includeSystemAudio: false }]);
    assert.equal((await persisted()).microphoneDeviceId, null);
    assert.equal((await persisted()).includeSystemAudio, true);

    // Main 恢复后再次保存成功，错误提示消失
    fail = false;
    await choose(view, 'mic-a');
    assert.equal(view.has('.error-notice'), false);
    assert.equal(view.select().value, 'mic-a');
    assert.equal((await persisted()).microphoneDeviceId, 'mic-a');
  });
}

test('controls are disabled while a save is pending and re-enabled once Main confirms', async (t) => {
  let release;
  const { api, base } = apiWith({
    update: (patch) =>
      new Promise((resolve) => {
        release = () => resolve(base.settings.update(patch));
      }),
  });
  const view = await mount(t, api, fakeMediaDevices([mic('mic-a', 'USB Mic')]));

  await choose(view, 'mic-a');
  assert.equal(view.select().disabled, true);
  assert.equal(view.checkbox().disabled, true);

  await act(async () => release());
  await settle();
  assert.equal(view.select().disabled, false);
  assert.equal(view.checkbox().disabled, false);
  assert.equal(view.select().value, 'mic-a');
});
