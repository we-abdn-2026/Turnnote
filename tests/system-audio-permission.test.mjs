/**
 * 系统音频与 macOS"屏幕与系统音频录制"权限：判断规则、提示文案、打开系统设置页的入口。
 * 起因：权限被拒绝时，采集失败的真实原因被统一吞成一句"系统音频不可用"，用户无从下手。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYSTEM_AUDIO_NEEDS_PERMISSION,
  SYSTEM_AUDIO_UNAVAILABLE,
  permissionSettingsUrl,
  systemAudioBlocked,
  systemAudioWarning,
} from '../out/tests/runtime.mjs';
import { createMainSession, failure, value } from './support/main-session.mjs';

const permissions = (screen) => ({ microphone: 'granted', screen });

test('only a macOS-style denied, restricted or undetermined screen permission blocks system audio', () => {
  for (const screen of ['denied', 'restricted', 'not-determined']) {
    assert.equal(systemAudioBlocked(permissions(screen)), true, screen);
  }
  // Windows 没有这项权限（恒为 granted），Linux 查询不到（unknown）：都不是权限问题
  for (const screen of ['granted', 'unknown']) {
    assert.equal(systemAudioBlocked(permissions(screen)), false, screen);
  }
  assert.equal(systemAudioBlocked(null), false);
  assert.equal(systemAudioBlocked(undefined), false);
});

test('the warning names the permission when that is the cause, and stays generic otherwise', () => {
  assert.equal(systemAudioWarning(permissions('denied')), SYSTEM_AUDIO_NEEDS_PERMISSION);
  assert.equal(systemAudioWarning(permissions('granted')), SYSTEM_AUDIO_UNAVAILABLE);
  assert.equal(systemAudioWarning(null), SYSTEM_AUDIO_UNAVAILABLE);
  assert.match(SYSTEM_AUDIO_NEEDS_PERMISSION, /屏幕与系统音频录制/);
  assert.match(SYSTEM_AUDIO_NEEDS_PERMISSION, /重新打开/);
  // 两种提示都要说清楚后果：这次只录麦克风
  for (const text of [SYSTEM_AUDIO_NEEDS_PERMISSION, SYSTEM_AUDIO_UNAVAILABLE]) {
    assert.match(text, /只录制麦克风/);
  }
});

test('settings pages exist only where the platform has them, and are fixed strings', () => {
  assert.match(
    permissionSettingsUrl('darwin', 'screen'),
    /^x-apple\.systempreferences:.*Privacy_ScreenCapture$/,
  );
  assert.match(permissionSettingsUrl('darwin', 'microphone'), /Privacy_Microphone$/);
  assert.equal(permissionSettingsUrl('win32', 'microphone'), 'ms-settings:privacy-microphone');
  assert.equal(
    permissionSettingsUrl('win32', 'screen'),
    null,
    'Windows has no screen-recording permission',
  );
  assert.equal(permissionSettingsUrl('linux', 'microphone'), null);
  assert.equal(permissionSettingsUrl('linux', 'screen'), null);
  // 没有任何拼接：同一个输入永远得到同一个地址
  assert.equal(
    permissionSettingsUrl('darwin', 'screen'),
    permissionSettingsUrl('darwin', 'screen'),
  );
});

test('opening the settings page goes through validation and the Main opener, nothing else', async (t) => {
  const opened = [];
  const env = await createMainSession(t, {
    openPermissionSettings: async (target) => {
      opened.push(target);
      return true;
    },
  });
  assert.equal(value(await env.api.recording.openPermissionSettings('screen')), null);
  assert.equal(value(await env.api.recording.openPermissionSettings('microphone')), null);
  assert.deepEqual(opened, ['screen', 'microphone']);

  // 只接受枚举值：任意地址、多余参数、缺参数都被共享校验拒绝，opener 不会被调用
  for (const args of [
    ['https://example.com'],
    ['x-apple.systempreferences:evil'],
    [],
    ['screen', 'extra'],
    [null],
  ]) {
    const result = await env.api.recording.openPermissionSettings(...args);
    failure(result, 'INVALID_INPUT');
  }
  assert.deepEqual(opened, ['screen', 'microphone']);
});

test('a platform without that settings page, or no opener at all, is NOT_IMPLEMENTED', async (t) => {
  const none = await createMainSession(t, { openPermissionSettings: async () => false });
  failure(await none.api.recording.openPermissionSettings('screen'), 'NOT_IMPLEMENTED');
  const missing = await createMainSession(t);
  failure(await missing.api.recording.openPermissionSettings('screen'), 'NOT_IMPLEMENTED');
});

test('a failing opener is reported safely, without leaking its message', async (t) => {
  const env = await createMainSession(t, {
    openPermissionSettings: async () => {
      throw new Error('/Users/someone/private/path failed');
    },
  });
  const result = await env.api.recording.openPermissionSettings('screen');
  failure(result, 'INTERNAL');
  assert.equal(JSON.stringify(result).includes('/Users/someone'), false);
});
