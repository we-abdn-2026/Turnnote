import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENUMERATE_FAILED_MESSAGE,
  SAVE_FAILED_MESSAGE,
  createMockApi,
  deriveDeviceView,
  loadDeviceSettings,
  saveDeviceSettings,
  scanAudioInputs,
} from '../out/tests/runtime.mjs';

const mic = (deviceId, label = '') => ({ deviceId, label, kind: 'audioinput', groupId: 'g' });
const speaker = (deviceId) => ({ deviceId, label: '', kind: 'audiooutput', groupId: 'g' });
const SETTINGS = {
  microphoneDeviceId: null,
  includeSystemAudio: true,
  transcriptionModel: 'small',
  transcriptionLanguage: 'auto',
  deepseekModel: 'deepseek-chat',
};
const GRANTED = { microphone: 'granted', screen: 'granted' };

/** 基于共享 mock API，只替换需要控制的方法 */
function apiWith({ permissions = GRANTED, settings, update } = {}) {
  const api = createMockApi({ seed: false });
  return {
    settings: {
      ...api.settings,
      ...(settings && { get: settings }),
      ...(update && { update }),
    },
    recording: {
      ...api.recording,
      getPermissions:
        typeof permissions === 'function'
          ? permissions
          : async () => ({ ok: true, value: permissions }),
    },
  };
}

function fakeMediaDevices(initial) {
  let list = initial;
  return {
    calls: 0,
    set(next) {
      list = next;
    },
    async enumerateDevices() {
      this.calls += 1;
      if (list instanceof Error) throw list;
      return list;
    },
  };
}

test('granted: loads settings, lists only audio inputs and persists the chosen device', async () => {
  const api = apiWith();
  const loaded = await loadDeviceSettings(api);
  assert.equal(loaded.ok, true);
  const scan = await scanAudioInputs(fakeMediaDevices([mic('mic-a', 'USB Mic'), speaker('spk')]));
  assert.deepEqual(
    scan.devices.map((d) => d.deviceId),
    ['mic-a'],
  );
  const view = deriveDeviceView(loaded.settings, loaded.permissions, scan.devices, scan.error);
  assert.equal(view.canSelectDevice, true);
  assert.deepEqual(
    view.options.map((o) => [o.value, o.label, o.disabled]),
    [
      ['', '系统默认麦克风', false],
      ['mic-a', 'USB Mic', false],
    ],
  );
  const saved = await saveDeviceSettings(api, { microphoneDeviceId: 'mic-a' });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.microphoneDeviceId, 'mic-a');
  const reread = await api.settings.get();
  assert.equal(reread.value.microphoneDeviceId, 'mic-a');
});

for (const microphone of ['denied', 'not-determined', 'restricted', 'unknown']) {
  test(`${microphone}: device selection is disabled and no device state is claimed`, async () => {
    const loaded = await loadDeviceSettings(
      apiWith({ permissions: { microphone, screen: 'granted' } }),
    );
    assert.equal(loaded.ok, true);
    // 未授权时组件不枚举设备，devices 保持 null
    const view = deriveDeviceView(loaded.settings, loaded.permissions, null, null);
    assert.equal(view.canSelectDevice, false);
    assert.equal(view.noDevices, false);
    assert.equal(view.selectedMissing, false);
  });
}

test('not yet scanned is not reported as "no devices"', () => {
  const view = deriveDeviceView(SETTINGS, GRANTED, null, null);
  assert.equal(view.scanned, false);
  assert.equal(view.noDevices, false);
});

test('empty list reports no microphone; a later scan after connecting lists the new device', async () => {
  const media = fakeMediaDevices([]);
  const empty = await scanAudioInputs(media);
  assert.equal(deriveDeviceView(SETTINGS, GRANTED, empty.devices, empty.error).noDevices, true);
  media.set([mic('mic-new', 'New Mic')]);
  const after = await scanAudioInputs(media);
  const view = deriveDeviceView(SETTINGS, GRANTED, after.devices, after.error);
  assert.equal(media.calls, 2);
  assert.equal(view.noDevices, false);
  assert.ok(view.options.some((o) => o.value === 'mic-new' && !o.disabled));
});

test('placeholder devices with an empty deviceId are not listed and do not duplicate the default option', async () => {
  // 页面尚未获得麦克风授权时，Chrome 只返回 deviceId 和 label 都为空的占位设备
  const scan = await scanAudioInputs(fakeMediaDevices([mic(''), mic(''), speaker('')]));
  assert.equal(scan.devices.length, 2);
  const view = deriveDeviceView(SETTINGS, GRANTED, scan.devices, scan.error);
  assert.deepEqual(view.options, [{ value: '', label: '系统默认麦克风', disabled: false }]);
  // 设备存在，只是暂不可单独选择，不能提示“未检测到麦克风”
  assert.equal(view.noDevices, false);
});

test('removed selected device stays visible as unavailable and the persisted setting is not rewritten', async () => {
  const writes = [];
  const base = apiWith();
  const api = apiWith({
    settings: base.settings.get,
    update: async (patch) => {
      writes.push(patch);
      return base.settings.update(patch);
    },
  });
  await saveDeviceSettings(api, { microphoneDeviceId: 'mic-old' });
  writes.length = 0;
  const settings = (await api.settings.get()).value;
  const media = fakeMediaDevices([mic('mic-old', 'Old'), mic('mic-new', 'New')]);
  const before = await scanAudioInputs(media);
  assert.equal(deriveDeviceView(settings, GRANTED, before.devices, null).selectedMissing, false);

  media.set([mic('mic-new', 'New')]);
  const after = await scanAudioInputs(media);
  const view = deriveDeviceView(settings, GRANTED, after.devices, after.error);
  assert.equal(view.selectedMissing, true);
  // select 的值仍是 mic-old，对应的可见选项存在且不可再选
  const stale = view.options.find((o) => o.value === 'mic-old');
  assert.deepEqual(stale, { value: 'mic-old', label: '已断开的设备（不可用）', disabled: true });
  assert.deepEqual(writes, []);
  assert.equal((await api.settings.get()).value.microphoneDeviceId, 'mic-old');
});

test('enumeration rejection and missing mediaDevices report a recoverable error, not "no devices"', async () => {
  for (const media of [fakeMediaDevices(new Error('boom')), undefined]) {
    const scan = await scanAudioInputs(media);
    assert.deepEqual(scan, { devices: [], error: ENUMERATE_FAILED_MESSAGE });
    assert.equal(deriveDeviceView(SETTINGS, GRANTED, scan.devices, scan.error).noDevices, false);
  }
});

test('query failure Result ends loading with that error; NOT_IMPLEMENTED is never treated as granted', async () => {
  const notImplemented = { code: 'NOT_IMPLEMENTED', message: 'Not implemented.' };
  const permissionsFailed = await loadDeviceSettings(
    apiWith({ permissions: async () => ({ ok: false, error: notImplemented }) }),
  );
  assert.deepEqual(permissionsFailed, { ok: false, error: notImplemented });
  const internal = { code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
  const settingsFailed = await loadDeviceSettings(
    apiWith({ settings: async () => ({ ok: false, error: internal }) }),
  );
  assert.deepEqual(settingsFailed, { ok: false, error: internal });
});

test('query rejection ends loading without exposing the underlying exception', async () => {
  const rejected = await loadDeviceSettings(
    apiWith({
      permissions: async () => {
        throw new Error('ipc closed at /private/path');
      },
    }),
  );
  assert.deepEqual(rejected, { ok: false, error: null });
});

test('retry after a failed query succeeds once the API recovers', async () => {
  let fail = true;
  const api = apiWith({
    permissions: async () =>
      fail
        ? { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented.' } }
        : { ok: true, value: GRANTED },
  });
  assert.equal((await loadDeviceSettings(api)).ok, false);
  fail = false;
  assert.equal((await loadDeviceSettings(api)).ok, true);
});

test('save failure Result and rejection both report safely and leave the confirmed settings unchanged', async () => {
  const base = apiWith();
  const failure = { code: 'INVALID_INPUT', message: 'Invalid input.' };
  for (const [update, message] of [
    [async () => ({ ok: false, error: failure }), failure.message],
    [
      async () => {
        throw new Error('ipc closed at /private/path');
      },
      SAVE_FAILED_MESSAGE,
    ],
  ]) {
    const api = apiWith({ settings: base.settings.get, update });
    for (const patch of [{ microphoneDeviceId: 'mic-a' }, { includeSystemAudio: false }]) {
      assert.deepEqual(await saveDeviceSettings(api, patch), { ok: false, message });
    }
    assert.deepEqual((await base.settings.get()).value.microphoneDeviceId, null);
    assert.equal((await base.settings.get()).value.includeSystemAudio, true);
  }
});
