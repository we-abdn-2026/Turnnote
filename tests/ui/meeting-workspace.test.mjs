// #11 在 dev:web 中挂载真实 MeetingWorkspace：创建、开始、停止、事件更新、订阅清理、错误。
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

const NOT_IMPLEMENTED = JSON.stringify({ code: 'NOT_IMPLEMENTED', message: 'Not available yet.' });

async function createMeeting(page, title) {
  await page.eval(`__ui.type('#meeting-title', ${JSON.stringify(title)})`);
  await page.eval(`__ui.click('新建会议')`);
  await page.waitFor(`__ui.status() === '已创建，未开始录音'`);
  return page.eval(`(async () => {
    const list = await __ui.api.meetings.list();
    return list.value.find((m) => m.title === ${JSON.stringify(title)}).id;
  })()`);
}

/** 点击开始录音并确认参会者授权提醒（#10） */
async function startRecording(page) {
  await page.eval(`__ui.click('开始录音')`);
  await page.eval(`__ui.click('已告知，开始录音')`);
}

test('create → start → stop shows Main-driven recording, captured and transcribing updates', async () => {
  const page = await browser.open();
  const id = await createMeeting(page, 'Weekly planning');
  assert.match(id, /^mock-/);
  assert.equal(await page.eval(`document.querySelector('h2').textContent`), 'Weekly planning');

  await startRecording(page);
  await page.waitFor(`__ui.status() === '录音中'`);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() === '转写完成'`, { timeout: 8000 });

  assert.deepEqual(await page.eval('__ui.statusHistory'), [
    '已创建，未开始录音',
    '录音中',
    '录音已保存',
    '正在转写',
    '转写完成',
  ]);
  // 状态文案与 Main/mock 中的状态一致，不是 Renderer 自行推导的
  assert.equal(
    await page.eval(`__ui.api.meetings.get(${JSON.stringify(id)}).then((r) => r.value.status)`),
    'transcribed',
  );
  assert.deepEqual(page.errors, []);
});

test('capture entry and workspace survive StrictMode with one listener each', async () => {
  const page = await browser.open();
  await createMeeting(page, 'Cleanup');
  assert.equal(
    await page.eval(`document.querySelectorAll('[aria-label="Audio recording"]').length`),
    1,
  );
  assert.equal(await page.eval(`document.querySelectorAll('.device-selector').length`), 1);
  assert.deepEqual(
    await page.eval(`[
      getComputedStyle(document.querySelector('.header .recording-controls')).display,
      getComputedStyle(document.querySelector('.workspace .recording-controls')).display,
    ]`),
    ['flex', 'block'],
  );
  // 音频入口和会议工作区各订阅一次；StrictMode 重挂载必须清理旧订阅。
  const { subscribed, unsubscribed } = await page.eval(
    '({ subscribed: __ui.subscribed, unsubscribed: __ui.unsubscribed })',
  );
  assert.ok(subscribed >= 4, `subscribed ${subscribed}`);
  assert.equal(subscribed - unsubscribed, 2);
  assert.deepEqual(page.errors, []);
});

test('updates and failures of other meetings do not change the workspace', async () => {
  const page = await browser.open();
  await createMeeting(page, 'Mine');
  const before = await page.eval('__ui.text()');
  await page.eval(`(async () => {
    const other = (await __ui.api.meetings.create('Other window')).value;
    const job = (await __ui.api.recording.start(other.id)).value.activeJobId;
    await __ui.api.recording.fail(other.id, job, 'CAPTURE_FAILED');
    const seeded = (await __ui.api.meetings.list()).value.find((m) => m.title === 'Weekly sync');
    await __ui.api.meetings.rename(seeded.id, 'Renamed elsewhere');
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await page.eval('__ui.text()'), before);
  assert.deepEqual(await page.eval('__ui.alerts()'), []);
});

test('while recording, a new meeting cannot be created and stop stays available', async () => {
  const page = await browser.open();
  const first = await createMeeting(page, 'First');
  await startRecording(page);
  await page.waitFor(`__ui.status() === '录音中'`);
  // 只用可见控件：输入标题后新建仍不可用，并说明原因
  await page.eval(`__ui.type('#meeting-title', 'Second')`);
  assert.deepEqual(
    await page.eval(`__ui.buttons().filter((b) => ['新建会议', '停止录音'].includes(b.label))`),
    [
      { label: '新建会议', disabled: true },
      { label: '停止录音', disabled: false },
    ],
  );
  assert.equal(await page.eval(`document.querySelector('#meeting-title').disabled`), true);
  assert.equal(
    await page.eval(`document.querySelector('#create-blocked')?.textContent`),
    '正在录音，停止录音后才能新建会议。',
  );
  // 即使绕过禁用直接提交表单，也不会发出创建请求
  await page.eval(`document.querySelector('.create-meeting').requestSubmit()`);
  assert.equal(await page.eval(`__ui.calls['meetings.create']`), 1);
  assert.equal(await page.eval(`document.querySelector('h2').textContent`), 'First');

  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() !== '录音中'`);
  assert.equal(await page.eval(`document.querySelector('#create-blocked')`), null);
  assert.equal(
    await page.eval(`__ui.api.meetings.get(${JSON.stringify(first)}).then((r) => r.value.status)`),
    'transcribing',
  );
  assert.deepEqual(page.errors, []);
});

test('switching to a new meeting after stopping ignores late events from the previous one', async () => {
  const page = await browser.open();
  const first = await createMeeting(page, 'First');
  await startRecording(page);
  await page.waitFor(`__ui.status() === '录音中'`);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() === '正在转写'`);
  // 第一场仍在转写时，通过表单新建第二场
  await createMeeting(page, 'Second');
  await page.waitFor(
    `__ui.api.meetings.get(${JSON.stringify(first)}).then((r) => r.value.status === 'transcribed')`,
    { timeout: 8000 },
  );
  assert.equal(await page.eval(`document.querySelector('h2').textContent`), 'Second');
  assert.equal(await page.eval('__ui.status()'), '已创建，未开始录音');
  assert.deepEqual(page.errors, []);
});

test('duplicate start clicks while pending send one request', async () => {
  const page = await browser.open();
  await createMeeting(page, 'Double click');
  await page.eval(`__ui.faults['recording.start'] = { type: 'hold' }`);
  await startRecording(page);
  await page.waitFor(`__ui.buttons().some((b) => b.label === '正在开始...' && b.disabled)`);
  await page.eval(`__ui.click('正在开始...')`);
  assert.equal(await page.eval(`__ui.calls['recording.start']`), 1);
  await page.eval(`delete __ui.faults['recording.start']; __ui.release('recording.start')`);
  await page.waitFor(`__ui.status() === '录音中'`);
  assert.equal(await page.eval(`__ui.calls['recording.start']`), 1);
});

test('start failure Result and rejection show a safe error and keep the meeting', async () => {
  const page = await browser.open();
  await createMeeting(page, 'Errors');
  await page.eval(`__ui.faults['recording.start'] = { type: 'result', error: ${NOT_IMPLEMENTED} }`);
  await startRecording(page);
  await page.waitFor(`__ui.alerts().some((a) => a.includes('Not available yet.'))`);
  assert.equal(await page.eval('__ui.status()'), '已创建，未开始录音');

  await page.eval(`__ui.faults['recording.start'] = { type: 'reject' }`);
  await startRecording(page);
  await page.waitFor(`__ui.alerts().some((a) => a.includes('操作失败，请重试。'))`);
  const text = await page.eval('__ui.text()');
  assert.equal(text.includes('/private/path'), false);
  assert.equal(await page.eval('__ui.status()'), '已创建，未开始录音');

  // 恢复后可以正常开始，错误被清除
  await page.eval(`delete __ui.faults['recording.start']`);
  await startRecording(page);
  await page.waitFor(`__ui.status() === '录音中'`);
  assert.deepEqual(await page.eval('__ui.alerts()'), []);
  assert.deepEqual(page.errors, []);
});

test('create failure keeps the typed title and selects no meeting', async () => {
  const page = await browser.open();
  await page.eval(`__ui.faults['meetings.create'] = { type: 'reject' }`);
  await page.eval(`__ui.type('#meeting-title', 'Kept title')`);
  await page.eval(`__ui.click('新建会议')`);
  await page.waitFor(`__ui.alerts().length === 1`);
  assert.equal(await page.eval(`document.querySelector('#meeting-title').value`), 'Kept title');
  assert.equal(await page.eval('__ui.status()'), null);
  // 空标题不能提交
  await page.eval(`__ui.type('#meeting-title', '   ')`);
  assert.equal(
    await page.eval(`__ui.buttons().find((b) => b.label === '新建会议').disabled`),
    true,
  );
});
