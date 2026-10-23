// 注入 dev:web 页面，在应用脚本之前运行。
// 包装应用赋值的 window.turnnote：统计调用和事件订阅，按测试需要注入失败或挂起请求。
// 应用本身、共享 mock 和真实组件都不做修改。
(() => {
  const ui = {
    calls: {},
    faults: {},
    held: {},
    subscribed: 0,
    unsubscribed: 0,
    progressSubscribed: 0,
    progressUnsubscribed: 0,
    statusHistory: [],
    api: null,
  };
  window.__ui = ui;

  const wrapMethod =
    (namespace, method, fn) =>
    (...args) => {
      const key = `${namespace}.${method}`;
      ui.calls[key] = (ui.calls[key] ?? 0) + 1;
      const fault = ui.faults[key];
      if (fault?.once) delete ui.faults[key];
      if (fault?.type === 'result') return Promise.resolve({ ok: false, error: fault.error });
      if (fault?.type === 'value')
        return Promise.resolve({ ok: true, value: structuredClone(fault.value) });
      if (fault?.type === 'reject') return Promise.reject(new Error('ipc closed at /private/path'));
      if (fault?.type === 'hold') {
        return new Promise((resolve) => {
          (ui.held[key] ??= []).push(() => resolve(fn(...args)));
        });
      }
      return fn(...args);
    };

  const wrap = (api) => {
    const wrapped = { ...api };
    for (const namespace of ['meetings', 'recording', 'transcription', 'notes', 'settings']) {
      wrapped[namespace] = {};
      for (const [method, fn] of Object.entries(api[namespace])) {
        wrapped[namespace][method] = wrapMethod(namespace, method, fn);
      }
    }
    wrapped.events = {
      ...api.events,
      onMeetingUpdated(listener) {
        ui.subscribed += 1;
        const off = api.events.onMeetingUpdated(listener);
        let active = true;
        return () => {
          if (active) ui.unsubscribed += 1;
          active = false;
          off();
        };
      },
      onJobProgress(listener) {
        ui.progressSubscribed += 1;
        const off = api.events.onJobProgress(listener);
        let active = true;
        return () => {
          if (active) ui.progressUnsubscribed += 1;
          active = false;
          off();
        };
      },
    };
    return wrapped;
  };

  let current;
  Object.defineProperty(window, 'turnnote', {
    configurable: true,
    get: () => current,
    set(api) {
      ui.api = api; // 未包装的 mock，供测试从“其他窗口”修改数据
      current = wrap(api);
    },
  });

  ui.release = (key) => {
    for (const resume of ui.held[key] ?? []) resume();
    delete ui.held[key];
  };

  const workspace = () => document.querySelector('[aria-label="录音工作区"]');
  ui.text = () => workspace()?.innerText ?? '';
  ui.status = () => workspace()?.querySelector('.meeting-status')?.textContent ?? null;
  ui.alerts = () =>
    [...(workspace()?.querySelectorAll('[role="alert"]') ?? [])].map((el) => el.innerText);
  ui.buttons = () =>
    [...(workspace()?.querySelectorAll('button') ?? [])].map((b) => ({
      label: b.textContent,
      disabled: b.disabled,
    }));
  ui.click = (label) => {
    const button = [...(workspace()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === label,
    );
    if (!button) throw new Error(`No button "${label}"`);
    button.click();
  };
  ui.type = (selector, value) => {
    const input = workspace().querySelector(selector);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // 记录状态文案的每次变化，过渡状态即使很快被替换也能被检查到
  new MutationObserver(() => {
    const status = ui.status();
    if (status !== null && ui.statusHistory.at(-1) !== status) ui.statusHistory.push(status);
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();
