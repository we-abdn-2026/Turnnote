// 二次启动不该去碰已经销毁的窗口：macOS 关窗后应用还在跑，旧引用上的任何调用都会抛
// “Object has been destroyed”（真实崩溃见 out/main 的 second-instance 处理器）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { focusMainWindow } from '../out/tests/runtime.mjs';

function fakeWindow({ destroyed = false, minimized = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => {
      calls.push('isMinimized');
      return minimized;
    },
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus'),
  };
}

const base = { ready: true, quitting: false };

test('a destroyed window is never touched; a new one is created instead', () => {
  const window = fakeWindow({ destroyed: true });
  let created = 0;
  const result = focusMainWindow({ ...base, window, createWindow: () => created++ });
  assert.equal(result, 'created');
  assert.equal(created, 1);
  assert.deepEqual(window.calls, []);
});

test('a missing window is created', () => {
  let created = 0;
  const result = focusMainWindow({ ...base, window: undefined, createWindow: () => created++ });
  assert.equal(result, 'created');
  assert.equal(created, 1);
});

test('a minimized window is restored and focused', () => {
  const window = fakeWindow({ minimized: true });
  const result = focusMainWindow({ ...base, window, createWindow: () => {} });
  assert.equal(result, 'focused');
  assert.deepEqual(window.calls, ['isMinimized', 'restore', 'focus']);
});

test('a visible window is focused once', () => {
  const window = fakeWindow();
  focusMainWindow({ ...base, window, createWindow: () => {} });
  assert.deepEqual(window.calls, ['isMinimized', 'focus']);
});

test('nothing happens before startup finishes or while quitting', () => {
  for (const flags of [{ ready: false }, { quitting: true }]) {
    const window = fakeWindow({ destroyed: true });
    let created = 0;
    const result = focusMainWindow({ ...base, ...flags, window, createWindow: () => created++ });
    assert.equal(result, 'ignored');
    assert.equal(created, 0);
    assert.deepEqual(window.calls, []);
  }
});
