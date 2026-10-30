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
  const segments = Array.from({ length: 120 }, (_, index) => {
    const startMs = index === 119 ? 3_601_000 : index * 1000;
    return {
      startMs,
      endMs: startMs + 1000,
      text: index === 0 ? '第一行中文\nSecond line in English.' : `片段 ${index}`,
    };
  });
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
      hourGapIsVisible: (() => {
        const row = document.querySelectorAll('.transcript-segment')[119];
        const time = row.querySelector('.transcript-time').getBoundingClientRect();
        const text = row.querySelector('.transcript-text').getBoundingClientRect();
        return text.left - time.right >= 15;
      })(),
      scrolls: document.querySelector('.transcript-list').scrollHeight > document.querySelector('.transcript-list').clientHeight,
    })`),
    {
      firstId: 'transcript-segment-0',
      firstIndex: '0',
      firstText: '第一行中文\nSecond line in English.',
      lastId: 'transcript-segment-119',
      lastTime: '01:00:01–01:00:02',
      hourGapIsVisible: true,
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

test('note display renders every section, optional times and unspecified values', async () => {
  const page = await browser.open();
  const version = {
    version: 1,
    source: 'generated',
    createdAt: '2026-10-30T05:00:00.000Z',
    note: {
      summary:
        'The team agreed on the Friday launch. averylongunbrokenwordthatexceedsthecontentwidthandmustwrapcleanly. 团队还确认需要准备发布说明和回滚方案。',
      keyTopics: ['Launch plan', 'Pricing'],
      decisions: [
        { text: 'Ship the beta on Friday.', timestampMs: 2400 },
        { text: 'Keep the current price until customer interviews finish.' },
      ],
      openQuestions: ['What is the team plan price?'],
      actionItems: [
        {
          task: 'Prepare the release notes',
          owner: 'Alex',
          dueDate: 'unspecified',
          timestampMs: 5200,
        },
        {
          task: 'Collect pricing feedback',
          owner: 'unspecified',
          dueDate: 'unspecified',
        },
        {
          task: 'Publish the launch announcement',
          owner: 'Jordan Lee',
          dueDate: 'Friday',
        },
      ],
    },
  };

  await page.eval(
    `__ui.faults['notes.getLatest'] = { type: 'value', value: ${JSON.stringify(version)} }`,
  );
  await createMeeting(page, 'Note display');
  await page.waitFor(`__ui.text().includes('Ship the beta on Friday.')`);

  assert.equal(await page.eval(`document.querySelector('.note-source').textContent`), 'AI 生成');
  assert.equal(
    await page.eval(`document.querySelector('.note-meta span:last-child').textContent`),
    '版本 1',
  );

  const displayed = await page.eval(`(() => {
    const summary = document.querySelector('.note-summary p');
    return {
      headings: [...document.querySelectorAll('.note-content h4')].map((h) => h.textContent),
      summary: summary.textContent,
      summaryWraps: summary.scrollWidth <= summary.clientWidth,
      topics: [...document.querySelectorAll('.note-topics li')].map((li) => li.textContent),
      decisions: [...document.querySelectorAll('[aria-label="决策"] li')].map(
        (li) => li.querySelector('.note-item-text').textContent,
      ),
      decisionTimes: [...document.querySelectorAll('[aria-label="决策"] .note-time')].map(
        (time) => time.textContent,
      ),
      questions: [...document.querySelectorAll('[aria-label="未决问题"] li')].map(
        (li) => li.textContent,
      ),
      actionMeta: [...document.querySelectorAll('.note-action')].map((item) =>
        [...item.querySelectorAll('dd')].map((dd) => dd.textContent),
      ),
      actionTimes: [...document.querySelectorAll('.note-action .note-time')].map(
        (time) => time.textContent,
      ),
    };
  })()`);

  assert.deepEqual(displayed.headings, ['摘要', '关键主题', '决策', '未决问题', '行动项']);
  assert.equal(displayed.summary.includes('mustwrapcleanly'), true);
  assert.equal(displayed.summaryWraps, true);
  assert.deepEqual(displayed.topics, ['Launch plan', 'Pricing']);
  assert.deepEqual(displayed.decisions, [
    'Ship the beta on Friday.',
    'Keep the current price until customer interviews finish.',
  ]);
  assert.deepEqual(displayed.decisionTimes, ['00:02']);
  assert.deepEqual(displayed.questions, ['What is the team plan price?']);
  assert.deepEqual(displayed.actionMeta, [
    ['Alex', '未指定'],
    ['未指定', '未指定'],
    ['Jordan Lee', 'Friday'],
  ]);
  assert.deepEqual(displayed.actionTimes, ['00:05']);
  assert.deepEqual(page.errors, []);
});

test('switching meetings clears the previous note while the new note loads', async () => {
  const page = await browser.open();
  const firstVersion = {
    version: 1,
    source: 'generated',
    createdAt: '2026-10-30T05:00:00.000Z',
    note: {
      summary: 'Only in the first meeting',
      keyTopics: ['First topic'],
      decisions: [],
      openQuestions: [],
      actionItems: [],
    },
  };

  await page.eval(
    `__ui.faults['notes.getLatest'] = { type: 'value', value: ${JSON.stringify(firstVersion)} }`,
  );
  await createMeeting(page, 'Note one');
  await page.waitFor(`__ui.text().includes('Only in the first meeting')`);

  await page.eval(`__ui.faults['notes.getLatest'] = { type: 'hold' }`);
  await createMeeting(page, 'Note two');

  assert.equal(await page.eval(`__ui.text().includes('Only in the first meeting')`), false);
  assert.equal(await page.eval(`document.querySelector('.note-content')`), null);
  assert.equal(await page.eval(`__ui.text().includes('正在加载纪要...')`), true);
  assert.equal(await page.eval(`document.querySelector('h2').textContent`), 'Note two');

  await page.eval(`
    delete __ui.faults['notes.getLatest'];
    __ui.release('notes.getLatest');
  `);
  await page.waitFor(`__ui.text().includes('暂无纪要内容')`);

  assert.equal(await page.eval(`__ui.text().includes('Only in the first meeting')`), false);
  assert.deepEqual(page.errors, []);
});
