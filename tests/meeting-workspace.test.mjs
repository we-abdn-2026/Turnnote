// 挂载实际 App（含 AudioDeviceSelector + MeetingWorkspace + RecordingControls），覆盖 #11 和 #10 的界面状态与 React 接线；
// 会话和视图逻辑见 meeting-session.test.mjs、recording-controls.test.mjs。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  act,
  click,
  createElement,
  document,
  render,
  settle,
  typeInto,
  waitFor,
  window,
} from './support/dom.mjs';

// 必须在 dom.mjs 注入 jsdom 全局对象之后再加载
const { App, createMockApi, createMockRecording } = await import('../out/tests/runtime.mjs');

const NOT_IMPLEMENTED = { code: 'NOT_IMPLEMENTED', message: 'Not available yet.' };

/**
 * 共享 mock API 外包一层：统计调用和事件订阅，按测试需要注入失败或挂起请求。
 * base 是未包装的 mock，代表“其他窗口”直接修改数据。
 */
function countedApi() {
  const base = createMockApi({ seed: true, delayMs: 1 });
  const calls = {};
  const faults = {};
  const held = {};
  const subscriptions = { subscribed: 0, unsubscribed: 0 };
  const wrap =
    (namespace, method, fn) =>
    (...args) => {
      const key = `${namespace}.${method}`;
      calls[key] = (calls[key] ?? 0) + 1;
      const fault = faults[key];
      if (fault?.once) delete faults[key];
      if (fault?.type === 'result') return Promise.resolve({ ok: false, error: fault.error });
      if (fault?.type === 'reject') return Promise.reject(new Error('ipc closed at /private/path'));
      if (fault?.type === 'hold') {
        return new Promise((resolve) => (held[key] ??= []).push(() => resolve(fn(...args))));
      }
      return fn(...args);
    };
  const api = { ...base };
  for (const namespace of ['meetings', 'recording', 'transcription', 'notes', 'settings']) {
    api[namespace] = Object.fromEntries(
      Object.entries(base[namespace]).map(([method, fn]) => [method, wrap(namespace, method, fn)]),
    );
  }
  api.events = {
    ...base.events,
    onMeetingUpdated(listener) {
      subscriptions.subscribed += 1;
      const off = base.events.onMeetingUpdated(listener);
      let active = true;
      return () => {
        if (active) subscriptions.unsubscribed += 1;
        active = false;
        off();
      };
    },
  };
  const release = async (key) => {
    await act(async () => {
      for (const resume of held[key] ?? []) resume();
      delete held[key];
    });
    await settle();
  };
  return { api, base, calls, faults, subscriptions, release };
}

async function mount(t) {
  const harness = countedApi();
  window.turnnote = harness.api;
  const { container, unmount } = await render(t, () =>
    createElement(App, { recordingFactory: createMockRecording }),
  );
  const $ = (selector) => container.querySelector(selector);
  const buttons = () => [...container.querySelectorAll('button')];
  const button = (label) => {
    const found = buttons().find((b) => b.textContent === label);
    if (!found)
      throw new Error(`No button "${label}"; have ${buttons().map((b) => b.textContent)}`);
    return found;
  };
  // 记录状态文案的每次变化，过渡状态即使很快被替换也能被检查到
  const statusHistory = [];
  const status = () => $('.meeting-status')?.textContent ?? null;
  const observer = new window.MutationObserver(() => {
    if (status() !== null && statusHistory.at(-1) !== status()) statusHistory.push(status());
  });
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  t.after(() => observer.disconnect());
  return {
    ...harness,
    $,
    unmount,
    status,
    statusHistory,
    title: () => $('h2')?.textContent ?? null,
    text: () => container.textContent,
    alerts: () => [...container.querySelectorAll('[role="alert"]')].map((el) => el.textContent),
    button,
    click: (label) => click(button(label)),
    /** 录音控制区快照；禁用按钮写作 (文案) */
    controls: () => {
      const root = $('.recording-controls');
      return {
        recording: root.querySelector('.recording-indicator')?.textContent ?? null,
        processing: root.querySelector('.processing-indicator')?.textContent ?? null,
        dialog: root.querySelector('[role="alertdialog"] strong')?.textContent ?? null,
        buttons: [...root.querySelectorAll('button')].map((b) =>
          b.disabled ? `(${b.textContent})` : b.textContent,
        ),
      };
    },
    waitForStatus: (expected, timeout) =>
      waitFor(() => status() === expected, { timeout, message: `status ${expected}` }),
  };
}

async function createMeeting(view, title) {
  await typeInto(view.$('#meeting-title'), title);
  await view.click('新建会议');
  await view.waitForStatus('已创建，未开始录音');
  return (await view.base.meetings.list()).value.find((m) => m.title === title).id;
}

/** 点击开始录音并确认参会者授权提醒 */
async function startRecording(view) {
  await view.click('开始录音');
  await view.click('已告知，开始录音');
  await view.waitForStatus('录音中');
}

const meetingStatus = async (view, id) => (await view.base.meetings.get(id)).value.status;

describe('#11 meeting workspace', () => {
  test('create → start → stop shows Main-driven recording, captured and transcribing updates', async (t) => {
    const view = await mount(t);
    const id = await createMeeting(view, 'Weekly planning');
    assert.match(id, /^mock-/);
    assert.equal(view.title(), 'Weekly planning');

    await startRecording(view);
    await view.click('停止录音');
    await view.waitForStatus('转写完成');

    assert.deepEqual(view.statusHistory, [
      '已创建，未开始录音',
      '录音中',
      '录音已保存',
      '正在转写',
      '转写完成',
    ]);
    // 状态文案与 Main/mock 中的状态一致，不是 Renderer 自行推导的
    assert.equal(await meetingStatus(view, id), 'transcribed');
  });

  test('App has one recording owner and cleans subscriptions in StrictMode', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Cleanup');
    // 全页面只有一个录音控制组件和一个设备选择器
    assert.equal(document.querySelectorAll('.recording-controls').length, 1);
    assert.equal(document.querySelectorAll('.device-selector').length, 1);
    // StrictMode 会卸载再挂载一次 effect，清理函数必须真正取消订阅
    assert.ok(view.subscriptions.subscribed >= 2, `subscribed ${view.subscriptions.subscribed}`);
    assert.equal(view.subscriptions.subscribed - view.subscriptions.unsubscribed, 1);
    await view.unmount();
    assert.equal(view.subscriptions.subscribed - view.subscriptions.unsubscribed, 0);
  });

  test('updates and failures of other meetings do not change the workspace', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Mine');
    const before = view.text();
    await act(async () => {
      const other = (await view.base.meetings.create('Other window')).value;
      const job = (await view.base.recording.start(other.id)).value.activeJobId;
      await view.base.recording.fail(other.id, job, 'CAPTURE_FAILED');
      const seeded = (await view.base.meetings.list()).value.find((m) => m.title === 'Weekly sync');
      await view.base.meetings.rename(seeded.id, 'Renamed elsewhere');
    });
    await settle();
    assert.equal(view.text(), before);
    assert.deepEqual(view.alerts(), []);
  });

  test('while recording, a new meeting cannot be created and stop stays available', async (t) => {
    const view = await mount(t);
    const first = await createMeeting(view, 'First');
    await startRecording(view);
    // 只用可见控件：输入标题后新建仍不可用，并说明原因
    await typeInto(view.$('#meeting-title'), 'Second');
    assert.equal(view.button('新建会议').disabled, true);
    assert.equal(view.button('停止录音').disabled, false);
    assert.equal(view.$('#meeting-title').disabled, true);
    assert.equal(view.$('#create-blocked')?.textContent, '正在录音，停止录音后才能新建会议。');
    // 即使绕过禁用直接提交表单，也不会发出创建请求
    await act(async () => view.$('.create-meeting').requestSubmit());
    await settle();
    assert.equal(view.calls['meetings.create'], 1);
    assert.equal(view.title(), 'First');

    await view.click('停止录音');
    await waitFor(() => view.status() !== '录音中', { message: 'recording ended' });
    assert.equal(view.$('#create-blocked'), null);
    assert.notEqual(await meetingStatus(view, first), 'recording');
  });

  test('switching to a new meeting after stopping ignores late events from the previous one', async (t) => {
    const view = await mount(t);
    // 将转写任务设为挂起，手动控制完成时机
    view.faults['transcription.transcribe'] = { type: 'hold' };
    const first = await createMeeting(view, 'First');
    await startRecording(view);
    await view.click('停止录音');
    await view.waitForStatus('正在转写');
    // 第一场转写任务已挂起，现在新建第二场
    await createMeeting(view, 'Second');
    await waitFor(() => view.title() === 'Second', { message: 'switched to second' });
    assert.equal(view.status(), '已创建，未开始录音');
    // 现在释放第一场的转写完成事件
    await view.release('transcription.transcribe');
    await waitFor(async () => (await meetingStatus(view, first)) === 'transcribed', {
      timeout: 100,
      message: 'first meeting completes',
    });
    await settle();
    // 第一场已完成，但第二场的标题和状态不应改变
    assert.equal(view.title(), 'Second');
    assert.equal(view.status(), '已创建，未开始录音');
  });

  test('duplicate start clicks while pending send one request', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Double click');
    view.faults['recording.start'] = { type: 'hold' };
    await view.click('开始录音');
    await view.click('已告知，开始录音');
    assert.equal(view.button('正在开始...').disabled, true);
    await view.click('正在开始...');
    assert.equal(view.calls['recording.start'], 1);
    delete view.faults['recording.start'];
    await view.release('recording.start');
    await view.waitForStatus('录音中');
    assert.equal(view.calls['recording.start'], 1);
  });

  test('start failure Result and rejection show a safe error and keep the meeting', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Errors');
    view.faults['recording.start'] = { type: 'result', error: NOT_IMPLEMENTED };
    await view.click('开始录音');
    await view.click('已告知，开始录音');
    assert.ok(view.alerts().some((a) => a.includes('Not available yet.')));
    assert.equal(view.status(), '已创建，未开始录音');

    view.faults['recording.start'] = { type: 'reject' };
    await view.click('开始录音');
    await view.click('已告知，开始录音');
    assert.ok(view.alerts().some((a) => a.includes('操作失败，请重试。')));
    assert.equal(view.text().includes('/private/path'), false);
    assert.equal(view.status(), '已创建，未开始录音');

    // 恢复后可以正常开始，错误被清除
    delete view.faults['recording.start'];
    await startRecording(view);
    assert.deepEqual(view.alerts(), []);
  });

  test('create failure keeps the typed title and selects no meeting; blank title cannot be submitted', async (t) => {
    const view = await mount(t);
    view.faults['meetings.create'] = { type: 'reject' };
    await typeInto(view.$('#meeting-title'), 'Kept title');
    await view.click('新建会议');
    assert.equal(view.alerts().length, 1);
    assert.equal(view.$('#meeting-title').value, 'Kept title');
    assert.equal(view.status(), null);
    await typeInto(view.$('#meeting-title'), '   ');
    assert.equal(view.button('新建会议').disabled, true);
  });
});

describe('#10 recording controls', () => {
  test('start shows the consent reminder first; cancelling sends no request', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Controls');
    assert.deepEqual(view.controls(), {
      recording: null,
      processing: null,
      dialog: null,
      buttons: ['开始录音'],
    });

    await view.click('开始录音');
    const prompting = view.controls();
    assert.equal(prompting.dialog, '开始录音前');
    assert.deepEqual(prompting.buttons, ['已告知，开始录音', '取消', '(开始录音)']);
    assert.equal(view.calls['recording.start'] ?? 0, 0);

    await view.click('取消');
    assert.deepEqual(view.controls().buttons, ['开始录音']);
    assert.equal(view.calls['recording.start'] ?? 0, 0);

    await startRecording(view);
    assert.equal(view.calls['recording.start'], 1);
  });

  test('recording shows a persistent indicator and only stop; processing is never shown as recording', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Controls');
    await startRecording(view);
    assert.deepEqual(view.controls(), {
      recording: '正在录音',
      processing: null,
      dialog: null,
      buttons: ['停止录音'],
    });
    assert.equal(view.$('.recording-indicator').getAttribute('role'), 'status');

    // 状态文案每次变化都记录一帧控制区，检查 captured/transcribing 期间的展示
    const frames = [];
    const observer = new window.MutationObserver(() =>
      frames.push({ status: view.status(), ...view.controls() }),
    );
    observer.observe(view.$('[aria-label="录音工作区"]'), {
      subtree: true,
      childList: true,
      characterData: true,
    });
    t.after(() => observer.disconnect());
    await view.click('停止录音');
    await view.waitForStatus('转写完成');
    const processing = frames.filter((f) => ['录音已保存', '正在转写'].includes(f.status));
    assert.ok(
      processing.some((f) => f.status === '正在转写'),
      'saw transcribing',
    );
    for (const frame of processing) {
      assert.equal(frame.recording, null, frame.status);
      assert.equal(frame.processing, '录音已结束，正在处理', frame.status);
      assert.deepEqual(frame.buttons, [], frame.status);
    }
    assert.deepEqual(view.controls(), {
      recording: null,
      processing: null,
      dialog: null,
      buttons: [],
    });
  });

  test('generating is shown as processing, not recording', async (t) => {
    const view = await mount(t);
    const id = await createMeeting(view, 'Controls');
    await startRecording(view);
    await view.click('停止录音');
    await view.waitForStatus('转写完成');
    await act(async () => {
      await view.base.settings.setApiKey('test-key');
      await view.base.notes.generate(id);
    });
    await view.waitForStatus('正在生成纪要');
    const v = view.controls();
    assert.equal(v.recording, null);
    assert.equal(v.processing, '录音已结束，正在处理');
    assert.deepEqual(v.buttons, []);
  });

  test('pending stop stays visible and disabled; duplicate clicks send one request', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Controls');
    await startRecording(view);
    view.faults['recording.stop'] = { type: 'hold' };
    await view.click('停止录音');
    assert.ok(view.controls().buttons.includes('(正在停止...)'));
    await view.click('正在停止...');
    // 等待 Main 确认期间仍然处于录音中
    assert.equal(view.controls().recording, '正在录音');
    assert.equal(view.calls['recording.stop'], 1);
    delete view.faults['recording.stop'];
    await view.release('recording.stop');
    await waitFor(() => view.status() !== '录音中', { message: 'recording ended' });
    assert.equal(view.calls['recording.stop'], 1);
  });

  test('start failure keeps start available; stop failure keeps recording and stop can be retried', async (t) => {
    const view = await mount(t);
    await createMeeting(view, 'Controls');
    view.faults['recording.start'] = {
      type: 'result',
      error: { code: 'PERMISSION_DENIED', message: 'Audio capture permission was denied.' },
      once: true,
    };
    await view.click('开始录音');
    await view.click('已告知，开始录音');
    assert.ok(view.alerts().some((a) => a.includes('Audio capture permission was denied.')));
    assert.deepEqual(view.controls().buttons, ['开始录音']);

    await startRecording(view);
    view.faults['recording.stop'] = { type: 'reject', once: true };
    await view.click('停止录音');
    assert.ok(view.alerts().some((a) => a.includes('操作失败，请重试。')));
    assert.deepEqual(view.controls(), {
      recording: '正在录音',
      processing: null,
      dialog: null,
      buttons: ['停止录音'],
    });
    await view.click('停止录音');
    await waitFor(() => view.status() !== '录音中', { message: 'recording ended' });
    assert.deepEqual(view.alerts(), []);
  });

  test('capture failure offers discard with confirmation, then recording can start again', async (t) => {
    const view = await mount(t);
    const id = await createMeeting(view, 'Controls');
    await startRecording(view);
    await act(async () => {
      const meeting = (await view.base.meetings.get(id)).value;
      await view.base.recording.fail(meeting.id, meeting.activeJobId, 'DEVICE_NOT_FOUND');
    });
    await waitFor(() => view.status()?.startsWith('处理失败'), { message: 'failed status' });
    assert.deepEqual(view.controls().buttons, ['丢弃录音']);

    await view.click('丢弃录音');
    const confirming = view.controls();
    assert.equal(confirming.dialog, '丢弃这次录音？');
    assert.deepEqual(confirming.buttons, ['丢弃并重新录音', '保留', '(丢弃录音)']);
    await view.click('保留');
    assert.equal(view.calls['recording.cancel'] ?? 0, 0);

    await view.click('丢弃录音');
    await view.click('丢弃并重新录音');
    await view.waitForStatus('已创建，未开始录音');
    assert.equal(view.calls['recording.cancel'], 1);
    await startRecording(view);
  });

  test('an open reminder closes when the meeting changes and never reappears on its own', async (t) => {
    const view = await mount(t);
    const id = await createMeeting(view, 'Controls');
    await view.click('开始录音');
    assert.equal(view.controls().dialog, '开始录音前');
    // 其他窗口更新了这场会议
    await act(async () => view.base.meetings.rename(id, 'Renamed elsewhere'));
    await waitFor(() => view.title() === 'Renamed elsewhere', { message: 'rename event' });
    assert.deepEqual(view.controls(), {
      recording: null,
      processing: null,
      dialog: null,
      buttons: ['开始录音'],
    });
  });
});

// 测试之间共享 jsdom 文档；确认每项都已卸载干净
test('every workspace test cleaned up its DOM', () => {
  assert.equal(document.body.children.length, 0);
});
