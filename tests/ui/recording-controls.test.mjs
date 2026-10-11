// #10 在 dev:web 中挂载真实 RecordingControls：授权提醒、录音指示、处理中状态、防重复、错误与恢复。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startBrowser } from './browser.mjs';

let browser;
before(async () => {
  browser = await startBrowser();
});
after(async () => {
  await browser?.close();
});

const controls = `(() => {
  const root = document.querySelector('.recording-controls');
  return {
    recording: root.querySelector('.recording-indicator')?.textContent ?? null,
    processing: root.querySelector('.processing-indicator')?.textContent ?? null,
    dialog: root.querySelector('[role=alertdialog] strong')?.textContent ?? null,
    buttons: [...root.querySelectorAll('button')].map((b) => (b.disabled ? '(' + b.textContent + ')' : b.textContent)),
  };
})()`;

async function createMeeting(page, title = 'Controls') {
  await page.eval(`__ui.type('#meeting-title', ${JSON.stringify(title)})`);
  await page.eval(`__ui.click('新建会议')`);
  await page.waitFor(`__ui.status() === '已创建，未开始录音'`);
  return page.eval(
    `__ui.api.meetings.list().then((r) => r.value.find((m) => m.title === ${JSON.stringify(title)}).id)`,
  );
}

async function startRecording(page) {
  await page.eval(`__ui.click('开始录音')`);
  await page.eval(`__ui.click('已告知，开始录音')`);
  await page.waitFor(`__ui.status() === '录音中'`);
}

test('start shows the consent reminder first; cancelling sends no request', async () => {
  const page = await browser.open();
  await createMeeting(page);
  assert.deepEqual(await page.eval(controls), {
    recording: null,
    processing: null,
    dialog: null,
    buttons: ['开始录音'],
  });

  await page.eval(`__ui.click('开始录音')`);
  const prompting = await page.eval(controls);
  assert.equal(prompting.dialog, '开始录音前');
  assert.deepEqual(prompting.buttons, ['已告知，开始录音', '取消', '(开始录音)']);
  assert.equal(await page.eval(`__ui.calls['recording.start'] ?? 0`), 0);

  await page.eval(`__ui.click('取消')`);
  assert.deepEqual((await page.eval(controls)).buttons, ['开始录音']);
  assert.equal(await page.eval(`__ui.calls['recording.start'] ?? 0`), 0);

  await startRecording(page);
  assert.equal(await page.eval(`__ui.calls['recording.start']`), 1);
  assert.deepEqual(page.errors, []);
});

test('recording shows a persistent indicator and only stop; processing is never shown as recording', async () => {
  const page = await browser.open();
  await createMeeting(page);
  await startRecording(page);
  assert.deepEqual(await page.eval(controls), {
    recording: '正在录音',
    processing: null,
    dialog: null,
    buttons: ['停止录音'],
  });
  assert.equal(
    await page.eval(`document.querySelector('.recording-indicator').getAttribute('role')`),
    'status',
  );

  // 观察整个工作区：状态文案每次变化都记录一帧控制区，检查 captured/transcribing 期间的展示
  await page.eval(`(() => {
    window.__frames = [];
    new MutationObserver(() => window.__frames.push({ status: __ui.status(), ...${controls} }))
      .observe(document.querySelector('[aria-label=录音工作区]'), { subtree: true, childList: true, characterData: true });
  })()`);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() === '转写完成'`, { timeout: 8000 });
  const frames = await page.eval('window.__frames');
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
  assert.deepEqual(await page.eval(controls), {
    recording: null,
    processing: null,
    dialog: null,
    buttons: [],
  });
  assert.deepEqual(page.errors, []);
});

test('generating is shown as processing, not recording', async () => {
  const page = await browser.open();
  const id = await createMeeting(page);
  await startRecording(page);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() === '转写完成'`, { timeout: 8000 });
  await page.eval(`(async () => {
    await __ui.api.settings.setApiKey('test-key');
    await __ui.api.notes.generate(${JSON.stringify(id)});
  })()`);
  await page.waitFor(`__ui.status() === '正在生成纪要'`);
  const v = await page.eval(controls);
  assert.equal(v.recording, null);
  assert.equal(v.processing, '录音已结束，正在处理');
  assert.deepEqual(v.buttons, []);
});

test('pending stop stays visible and disabled; duplicate clicks send one request', async () => {
  const page = await browser.open();
  await createMeeting(page);
  await startRecording(page);
  await page.eval(`__ui.faults['recording.stop'] = { type: 'hold' }`);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`${controls}.buttons.includes('(正在停止...)')`);
  await page.eval(`__ui.click('正在停止...')`);
  // 等待 Main 确认期间仍然处于录音中
  assert.equal((await page.eval(controls)).recording, '正在录音');
  assert.equal(await page.eval(`__ui.calls['recording.stop']`), 1);
  await page.eval(`delete __ui.faults['recording.stop']; __ui.release('recording.stop')`);
  await page.waitFor(`__ui.status() !== '录音中'`);
  assert.equal(await page.eval(`__ui.calls['recording.stop']`), 1);
});

test('start failure keeps start available; stop failure keeps recording and stop can be retried', async () => {
  const page = await browser.open();
  await createMeeting(page);
  const denied = JSON.stringify({
    code: 'PERMISSION_DENIED',
    message: 'Audio capture permission was denied.',
  });
  await page.eval(
    `__ui.faults['recording.start'] = { type: 'result', error: ${denied}, once: true }`,
  );
  await page.eval(`__ui.click('开始录音')`);
  await page.eval(`__ui.click('已告知，开始录音')`);
  await page.waitFor(
    `__ui.alerts().some((a) => a.includes('Audio capture permission was denied.'))`,
  );
  assert.deepEqual((await page.eval(controls)).buttons, ['开始录音']);

  await startRecording(page);
  await page.eval(`__ui.faults['recording.stop'] = { type: 'reject', once: true }`);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.alerts().some((a) => a.includes('操作失败，请重试。'))`);
  assert.deepEqual(await page.eval(controls), {
    recording: '正在录音',
    processing: null,
    dialog: null,
    buttons: ['停止录音'],
  });
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() !== '录音中'`);
  assert.deepEqual(await page.eval('__ui.alerts()'), []);
  assert.deepEqual(page.errors, []);
});

test('capture failure offers discard with confirmation, then recording can start again', async () => {
  const page = await browser.open();
  const id = await createMeeting(page);
  await startRecording(page);
  await page.eval(`(async () => {
    const meeting = (await __ui.api.meetings.get(${JSON.stringify(id)})).value;
    await __ui.api.recording.fail(meeting.id, meeting.activeJobId, 'DEVICE_NOT_FOUND');
  })()`);
  await page.waitFor(`__ui.status()?.startsWith('处理失败')`);
  assert.deepEqual((await page.eval(controls)).buttons, ['丢弃录音']);

  await page.eval(`__ui.click('丢弃录音')`);
  const confirming = await page.eval(controls);
  assert.equal(confirming.dialog, '丢弃这次录音？');
  assert.deepEqual(confirming.buttons, ['丢弃并重新录音', '保留', '(丢弃录音)']);
  await page.eval(`__ui.click('保留')`);
  assert.equal(await page.eval(`__ui.calls['recording.cancel'] ?? 0`), 0);

  await page.eval(`__ui.click('丢弃录音')`);
  await page.eval(`__ui.click('丢弃并重新录音')`);
  await page.waitFor(`__ui.status() === '已创建，未开始录音'`);
  assert.equal(await page.eval(`__ui.calls['recording.cancel']`), 1);
  await startRecording(page);
  assert.deepEqual(page.errors, []);
});

test('an open reminder closes when the meeting changes and never reappears on its own', async () => {
  const page = await browser.open();
  const id = await createMeeting(page);
  await page.eval(`__ui.click('开始录音')`);
  assert.equal((await page.eval(controls)).dialog, '开始录音前');
  // 其他窗口更新了这场会议
  await page.eval(`__ui.api.meetings.rename(${JSON.stringify(id)}, 'Renamed elsewhere')`);
  await page.waitFor(`document.querySelector('h2').textContent === 'Renamed elsewhere'`);
  assert.deepEqual(await page.eval(controls), {
    recording: null,
    processing: null,
    dialog: null,
    buttons: ['开始录音'],
  });
});
