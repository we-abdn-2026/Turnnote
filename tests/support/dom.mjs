// Renderer 组件测试共用的 jsdom 环境：挂载真实组件，使用真实 React。
// React DOM 在加载时检测浏览器环境，必须先注入 jsdom 全局对象再导入 React 和 out/tests/runtime.mjs。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

export const { window } = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
export const { document } = window;
for (const key of ['window', 'document', 'navigator']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export const { StrictMode, act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');

/** 等待 mock Promise 与随后的 React 更新全部完成 */
export async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** 轮询直到条件成立；用于等待 mock 中带延迟的后台任务 */
export async function waitFor(predicate, { timeout = 3000, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
}

/** 与 main.tsx 一样在 StrictMode 下挂载，测试结束时卸载并断言没有 React 报错 */
export async function render(t, component) {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(() => root.unmount());
    container.remove();
  };
  t.after(async () => {
    await unmount();
    console.error = originalError;
    assert.deepEqual(errors, []);
  });
  await act(() => root.render(createElement(StrictMode, null, createElement(component))));
  await settle();
  return { container, unmount, errors };
}

export async function click(element) {
  await act(async () => element.click());
  await settle();
}

/** 受控输入：经原型 setter 写值，React 才能识别为用户输入 */
export async function typeInto(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle();
}
