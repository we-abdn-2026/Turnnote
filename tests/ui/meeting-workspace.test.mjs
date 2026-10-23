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
  await page.waitFor(
    `__ui.status() === '已创建，未开始录音' && document.querySelector('h2')?.textContent === ${JSON.stringify(title)}`,
  );
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
  await page.waitFor(`document.querySelectorAll('.transcript-segment').length === 4`);

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
  assert.deepEqual(
    await page.eval(`({
      id: document.querySelector('.transcript-segment').id,
      start: document.querySelector('.transcript-segment').dataset.startMs,
      time: document.querySelector('.transcript-time').textContent,
      text: document.querySelector('.transcript-text').textContent,
    })`),
    {
      id: 'transcript-segment-0',
      start: '0',
      time: '00:00–00:02',
      text: "Let's review the launch plan for this week.",
    },
  );
  assert.deepEqual(page.errors, []);
});

test('transcript shows a long bilingual, multiline list with stable segment anchors', async () => {
  const page = await browser.open();
  const segments = Array.from({ length: 120 }, (_, index) => ({
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: index === 0 ? '第一行中文\nSecond line in English.' : `片段 ${index}`,
  }));
  await page.eval(
    `__ui.faults['transcription.getSegments'] = { type: 'value', value: ${JSON.stringify(segments)} }`,
  );
  await createMeeting(page, 'Long transcript');
  await page.waitFor(`document.querySelectorAll('.transcript-segment').length === 120`);

  assert.deepEqual(
    await page.eval(`({
      firstId: document.querySelector('.transcript-segment').id,
      firstIndex: document.querySelector('.transcript-segment').dataset.segmentIndex,
      firstText: document.querySelector('.transcript-text').textContent,
      lastId: document.querySelectorAll('.transcript-segment')[119].id,
      lastTime: document.querySelectorAll('.transcript-time')[119].textContent,
      scrolls: document.querySelector('.transcript-list').scrollHeight > document.querySelector('.transcript-list').clientHeight,
    })`),
    {
      firstId: 'transcript-segment-0',
      firstIndex: '0',
      firstText: '第一行中文\nSecond line in English.',
      lastId: 'transcript-segment-119',
      lastTime: '01:59–02:00',
      scrolls: true,
    },
  );
  assert.deepEqual(page.errors, []);
});

test('transcript has empty and failure states, then retries successfully', async () => {
  const page = await browser.open();
  const id = await createMeeting(page, 'Empty transcript');
  await page.waitFor(`__ui.text().includes('暂无转写内容')`);

  await page.eval(`
    __ui.faults['transcription.getSegments'] = {
      type: 'result',
      error: ${NOT_IMPLEMENTED},
    };
    __ui.api.meetings.rename(${JSON.stringify(id)}, 'Empty transcript renamed');
  `);
  await page.waitFor(
    `__ui.alerts().some((message) => message.includes('转写内容加载失败，请重试。'))`,
  );
  await page.eval(`delete __ui.faults['transcription.getSegments']`);
  await page.eval(`__ui.click('重新加载')`);
  await page.waitFor(`__ui.text().includes('暂无转写内容')`);
  assert.ok(await page.eval(`__ui.calls['transcription.getSegments'] >= 3`));
  assert.deepEqual(await page.eval('__ui.alerts()'), []);
  assert.deepEqual(page.errors, []);
});

test('switching meetings removes the previous transcript before the new request finishes', async () => {
  const page = await browser.open();
  await page.eval(`
    __ui.faults['transcription.getSegments'] = {
      type: 'value',
      value: [{ startMs: 0, endMs: 1000, text: 'Only in the first meeting' }],
    }
  `);
  await createMeeting(page, 'Transcript one');
  await page.waitFor(`__ui.text().includes('Only in the first meeting')`);

  await page.eval(`__ui.faults['transcription.getSegments'] = { type: 'hold' }`);
  await createMeeting(page, 'Transcript two');
  assert.equal(await page.eval(`__ui.text().includes('Only in the first meeting')`), false);
  assert.equal(await page.eval(`document.querySelectorAll('.transcript-segment').length`), 0);
  assert.equal(await page.eval(`__ui.text().includes('正在加载转写内容...')`), true);

  await page.eval(`
    delete __ui.faults['transcription.getSegments'];
    __ui.release('transcription.getSegments');
  `);
  await page.waitFor(`__ui.text().includes('暂无转写内容')`);
  assert.deepEqual(page.errors, []);
});

test('workspace has one recording owner and cleans subscriptions in StrictMode', async () => {
  const page = await browser.open();
  await createMeeting(page, 'Cleanup');
  assert.equal(await page.eval(`document.querySelectorAll('.recording-controls').length`), 1);
  assert.equal(await page.eval(`document.querySelectorAll('.device-selector').length`), 1);
  const { subscribed, unsubscribed, progressSubscribed, progressUnsubscribed } = await page.eval(
    '({ subscribed: __ui.subscribed, unsubscribed: __ui.unsubscribed, progressSubscribed: __ui.progressSubscribed, progressUnsubscribed: __ui.progressUnsubscribed })',
  );
  assert.ok(subscribed >= 2, `subscribed ${subscribed}`);
  assert.equal(subscribed - unsubscribed, 1);
  assert.ok(progressSubscribed >= 2, `progress subscribed ${progressSubscribed}`);
  assert.equal(progressSubscribed - progressUnsubscribed, 1);
  assert.deepEqual(page.errors, []);
});

test('workspace shows transcription and generation progress through their terminal states', async () => {
  const page = await browser.open();
  const id = await createMeeting(page, 'Processing progress');
  await startRecording(page);
  await page.waitFor(`__ui.status() === '录音中'`);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() === '正在转写'`);
  assert.equal(
    await page.eval(
      `document.querySelector('.processing-progress-heading')?.textContent.includes('等待进度上报')`,
    ),
    true,
  );
  assert.equal(
    await page.eval(
      `document.querySelector('.processing-progress')?.querySelector('progress')?.hasAttribute('value')`,
    ),
    false,
  );
  await page.waitFor(
    `document.querySelector('.processing-progress')?.querySelector('progress')?.hasAttribute('value')`,
  );
  assert.equal(
    await page.eval(
      `document.querySelector('.processing-progress-heading').textContent.includes('转写进度')`,
    ),
    true,
  );
  await page.waitFor(`__ui.status() === '转写完成'`, { timeout: 8000 });
  assert.equal(await page.eval(`document.querySelector('.processing-progress')`), null);

  const generation = await page.eval(`(async () => {
    await __ui.api.settings.setApiKey('test-only-key');
    return await __ui.api.notes.generate(${JSON.stringify(id)});
  })()`);
  assert.equal(generation.ok, true, JSON.stringify(generation));
  await page.waitFor(`__ui.status() === '正在生成纪要'`);
  await page.waitFor(
    `document.querySelector('.processing-progress')?.querySelector('progress')?.hasAttribute('value')`,
  );
  assert.equal(
    await page.eval(
      `document.querySelector('.processing-progress-heading').textContent.includes('纪要生成进度')`,
    ),
    true,
  );
  await page.waitFor(`__ui.status() === '纪要已生成'`, { timeout: 8000 });
  assert.equal(await page.eval(`document.querySelector('.processing-progress')`), null);
  assert.deepEqual(page.errors, []);
});

test('workspace reports transcription cancellation and ignores its late progress', async () => {
  const page = await browser.open();
  const id = await createMeeting(page, 'Cancel transcription');
  await startRecording(page);
  await page.waitFor(`__ui.status() === '录音中'`);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() === '正在转写'`);
  await page.eval(`(async () => {
    const meeting = (await __ui.api.meetings.get(${JSON.stringify(id)})).value;
    await __ui.api.transcription.cancel(meeting.id, meeting.activeJobId);
  })()`);
  await page.waitFor(`__ui.status() === '转写已取消，录音已保存'`);
  assert.equal(await page.eval(`document.querySelector('.processing-progress')`), null);
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
