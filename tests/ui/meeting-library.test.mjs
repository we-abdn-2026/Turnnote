// #86 #30 #31 #34 #35：在 dev:web 中挂载真实应用，验证会议库、来源定位、键盘与焦点、删除确认、纪要编辑和窄窗口。
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

/** 通过 CDP 发送真实按键，覆盖原生 <dialog> 的 cancel 行为 */
async function press(page, key, code = key, keyCode = 27) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }
}

const focused = `(() => {
  const el = document.activeElement;
  return el ? (el.id || el.getAttribute('aria-label') || el.textContent.trim()) : null;
})()`;

async function openSeeded(page) {
  await page.waitFor(
    `[...document.querySelectorAll('.reel')].some((r) => r.textContent.includes('Weekly sync'))`,
  );
  await page.eval(
    `[...document.querySelectorAll('.reel')].find((r) => r.textContent.includes('Weekly sync')).click()`,
  );
  await page.waitFor(
    `__ui.status() === '纪要已生成' && document.querySelectorAll('.transcript-segment').length === 4`,
  );
  await page.waitFor(`!!document.querySelector('.note-content')`);
}

test('library lists Main meetings, opens one and marks it current; switching is blocked while recording', async () => {
  const page = await browser.open();
  assert.equal(await page.eval('__ui.status()'), null);
  await openSeeded(page);
  assert.equal(await page.eval(`document.querySelector('h2').textContent`), 'Weekly sync');
  assert.equal(
    await page.eval(`document.querySelector('.reel[aria-current="true"] .reel-title').textContent`),
    'Weekly sync',
  );

  await page.eval(`__ui.type('#meeting-title', 'Live one')`);
  await page.eval(`__ui.click('新建会议')`);
  await page.waitFor(`__ui.status() === '已创建，未开始录音'`);
  await page.eval(`__ui.click('开始录音')`);
  await page.eval(`__ui.click('已告知，开始录音')`);
  await page.waitFor(`__ui.status() === '录音中'`);
  await page.waitFor(`document.querySelectorAll('.reel').length === 2`);
  assert.deepEqual(
    await page.eval(
      `[...document.querySelectorAll('.reel')].map((r) => [r.querySelector('.reel-title').textContent, r.disabled])`,
    ),
    [
      ['Live one', false],
      ['Weekly sync', true],
    ],
  );
  assert.equal(await page.eval(`!!document.querySelector('.recording-indicator .dot-rec')`), true);
  await page.eval(`__ui.click('停止录音')`);
  await page.waitFor(`__ui.status() !== '录音中'`);
  assert.deepEqual(page.errors, []);
});

test('library search matches titles and transcript text, with an honest empty result', async () => {
  const page = await browser.open();
  await page.waitFor(`document.querySelectorAll('.reel').length === 1`);
  await page.eval(`(() => {
    const input = document.querySelector('[aria-label="搜索会议"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'release notes');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(
    `document.querySelector('.reel-list')?.getAttribute('aria-label') === '搜索结果：release notes'`,
  );
  assert.equal(await page.eval(`document.querySelectorAll('.reel').length`), 1);

  await page.eval(`(() => {
    const input = document.querySelector('[aria-label="搜索会议"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'nothing-like-this');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(
    `document.querySelector('.library-message')?.textContent.includes('nothing-like-this')`,
  );
  assert.equal(await page.eval(`document.querySelectorAll('.reel').length`), 0);
  assert.deepEqual(page.errors, []);
});

test('a note timecode cues its transcript segment, lights it and moves focus there', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.click('定位到转写 00:00:02')`);
  await page.waitFor(
    `document.querySelector('.transcript-segment.is-cued')?.dataset.segmentIndex === '1'`,
  );
  assert.equal(await page.eval(focused), 'transcript-segment-1');
  assert.equal(
    await page.eval(
      `document.querySelector('.transcript-segment.is-cued').getAttribute('aria-current')`,
    ),
    'true',
  );
  // 没有来源时间的条目不伪造定位
  assert.ok(await page.eval(`document.querySelectorAll('.note-nosource').length >= 1`));

  await page.eval(`__ui.click('定位到转写 00:00:08')`);
  await page.waitFor(
    `document.querySelector('.transcript-segment.is-cued')?.dataset.segmentIndex === '3'`,
  );
  assert.equal(
    await page.eval(`document.querySelectorAll('.transcript-segment.is-cued').length`),
    1,
  );
  assert.deepEqual(page.errors, []);
});

test('real Escape cancels each confirmation without side effects and focus returns to the opener', async () => {
  const page = await browser.open();
  await page.eval(`__ui.type('#meeting-title', 'Keyboard')`);
  await page.eval(`__ui.click('新建会议')`);
  await page.waitFor(`__ui.status() === '已创建，未开始录音'`);

  await page.eval(
    `[...document.querySelectorAll('button')].find((b) => b.textContent === '开始录音').focus()`,
  );
  await page.eval(`__ui.click('开始录音')`);
  await page.waitFor(`!!document.querySelector('dialog[open]')`);
  assert.equal(await page.eval(focused), '已告知，开始录音');
  await press(page, 'Escape');
  await page.waitFor(`!document.querySelector('dialog')`);
  assert.equal(await page.eval(`__ui.calls['recording.start'] ?? 0`), 0);
  assert.equal(await page.eval(focused), '开始录音');

  await page.eval(`__ui.click('删除会议')`);
  await page.waitFor(`!!document.querySelector('dialog[open]')`);
  // 危险操作默认聚焦在取消上
  assert.equal(await page.eval(focused), '取消');
  await press(page, 'Escape');
  await page.waitFor(`!document.querySelector('dialog')`);
  assert.equal(await page.eval(`__ui.calls['meetings.delete'] ?? 0`), 0);
  assert.equal(await page.eval('__ui.status()'), '已创建，未开始录音');
  assert.deepEqual(page.errors, []);
});

test('delete asks first, then removes the meeting from the workspace and the library', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.click('删除会议')`);
  const dialog = await page.eval(`document.querySelector('[role=alertdialog]').innerText`);
  assert.match(dialog, /无法恢复/);
  assert.match(dialog, /已发送给 DeepSeek 的转写文本不会因为本机删除而被删除/);
  await page.eval(`__ui.click('取消')`);
  assert.equal(await page.eval(`__ui.calls['meetings.delete'] ?? 0`), 0);

  await page.eval(`__ui.click('删除会议')`);
  await page.eval(`__ui.click('删除会议记录')`);
  await page.waitFor(`__ui.status() === null && document.querySelectorAll('.reel').length === 0`);
  assert.equal(await page.eval(`__ui.calls['meetings.delete']`), 1);
  assert.equal(await page.eval(`!!document.querySelector('.empty-stage')`), true);
  assert.deepEqual(page.errors, []);
});

test('note editing saves a user version; cancelling with changes asks before discarding', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.click('编辑纪要')`);
  await page.waitFor(`!!document.querySelector('#edit-summary')`);
  // 导出不能导出未保存的草稿
  assert.equal(
    await page.eval(`__ui.buttons().find((b) => b.label === '导出 Markdown').disabled`),
    true,
  );
  await page.eval(`(() => {
    const area = document.querySelector('#edit-summary');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '人工核对后的摘要');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await page.eval(`__ui.click('取消编辑')`);
  await page.waitFor(
    `document.querySelector('dialog[open] strong')?.textContent === '放弃未保存的修改？'`,
  );
  await page.eval(`__ui.click('继续编辑')`);
  assert.equal(
    await page.eval(`document.querySelector('#edit-summary').value`),
    '人工核对后的摘要',
  );

  await page.eval(`__ui.click('保存纪要')`);
  await page.waitFor(`document.querySelector('.note-source')?.textContent === '用户编辑'`);
  assert.equal(
    await page.eval(`document.querySelector('.note-summary p').textContent`),
    '人工核对后的摘要',
  );
  assert.equal(
    await page.eval(`document.querySelector('.note-meta span:last-child').textContent`),
    '版本 2',
  );
  assert.equal(await page.eval(`__ui.calls['notes.saveEdit']`), 1);
  assert.deepEqual(page.errors, []);
});

test('a save conflict keeps the draft and explains the recovery', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.click('编辑纪要')`);
  await page.waitFor(`!!document.querySelector('#edit-summary')`);
  await page.eval(`(() => {
    const area = document.querySelector('#edit-summary');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '我的草稿');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.eval(`__ui.faults['notes.saveEdit'] = {
    type: 'result',
    once: true,
    error: { code: 'CONFLICT', message: 'The note has changed.' },
  }`);
  await page.eval(`__ui.click('保存纪要')`);
  await page.waitFor(`__ui.alerts().some((a) => a.includes('纪要已在别处更新'))`);
  assert.equal(await page.eval(`document.querySelector('#edit-summary').value`), '我的草稿');
  assert.deepEqual(page.errors, []);
});

test('narrow window: library is a drawer, the note fills the width, the transcript replaces it when opened', async () => {
  const page = await browser.open();
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 420,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitFor(
    `getComputedStyle(document.querySelector('.library')).visibility === 'hidden'`,
  );
  await page.eval(`__ui.click('会议库')`);
  await page.waitFor(
    `getComputedStyle(document.querySelector('.library')).visibility === 'visible'`,
  );
  await openSeeded(page);
  await page.waitFor(`document.querySelector('.shell').dataset.library === 'closed'`);

  assert.equal(await page.eval(`document.documentElement.scrollWidth > window.innerWidth`), false);
  assert.equal(
    await page.eval(`getComputedStyle(document.querySelector('.canvas')).display`),
    'flex',
  );

  // 点纪要里的时间码：转写抽屉接管整个宽度，并定位到来源
  await page.eval(`__ui.click('定位到转写 00:00:02')`);
  await page.waitFor(`document.querySelector('.workspace').dataset.drawer === 'open'`);
  await page.waitFor(
    `document.querySelector('.transcript-segment.is-cued')?.dataset.segmentIndex === '1'`,
  );
  assert.equal(
    await page.eval(`getComputedStyle(document.querySelector('.canvas')).display`),
    'none',
  );
  assert.equal(await page.eval(`document.documentElement.scrollWidth > window.innerWidth`), false);

  // 收起转写，回到纪要
  await page.eval(`__ui.click('收起转写')`);
  await page.waitFor(`document.querySelector('.workspace').dataset.drawer === 'closed'`);
  assert.equal(
    await page.eval(`getComputedStyle(document.querySelector('.canvas')).display`),
    'flex',
  );
  assert.deepEqual(page.errors, []);
});

test('hovering a transcript line links the note entries that cite it', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.click('定位到转写 00:00:02')`);
  await page.waitFor(`document.querySelector('.workspace').dataset.drawer === 'open'`);
  await page.eval(
    `document.querySelector('[data-start-ms="2400"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`,
  );
  await page.waitFor(`document.querySelectorAll('.edl-row[data-linked="true"]').length === 1`);
  assert.match(
    await page.eval(`document.querySelector('.edl-row[data-linked="true"]').textContent`),
    /Ship the beta on Friday/,
  );
  await page.eval(
    `document.querySelector('[data-start-ms="2400"]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))`,
  );
  await page.waitFor(`document.querySelectorAll('.edl-row[data-linked="true"]').length === 0`);
  assert.deepEqual(page.errors, []);
});

test('double-clicking the title starts renaming, and a closed transcript drawer is inert', async () => {
  const page = await browser.open();
  await openSeeded(page);
  assert.equal(await page.eval(`document.querySelector('.drawer').inert`), true);
  await page.eval(
    `document.querySelector('.doc h2').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
  );
  await page.waitFor(`!!document.querySelector('#rename-title')`);
  assert.equal(await page.eval(`document.querySelector('#rename-title').value`), 'Weekly sync');
  await page.eval(`__ui.click('转写')`);
  await page.waitFor(`document.querySelector('.drawer').inert === false`);
  assert.deepEqual(page.errors, []);
});

test('export confirmation is a toast that disappears by itself', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.click('导出 Markdown')`);
  await page.waitFor(`!!document.querySelector('.toast')`);
  assert.match(await page.eval(`document.querySelector('.toast').textContent`), /已导出/);
  await page.waitFor(`!document.querySelector('.toast')`, { timeout: 6000 });
  assert.deepEqual(page.errors, []);
});

const keyCombo = async (page, key, code, keyCode, modifiers = 4) => {
  // modifiers: 2 = Ctrl, 4 = Meta。应用按平台择一，这里两种都发
  for (const mod of [2, 4]) {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers: mod,
      });
    }
  }
  void modifiers;
};

test('global shortcuts focus the new-meeting field and search, and toggle the drawer', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await keyCombo(page, 'n', 'KeyN', 78);
  await page.waitFor(`document.activeElement?.id === 'meeting-title'`);
  await keyCombo(page, 'k', 'KeyK', 75);
  await page.waitFor(`document.activeElement?.id === 'library-search'`);
  await keyCombo(page, 'j', 'KeyJ', 74);
  await page.waitFor(`document.querySelector('.workspace').dataset.drawer === 'open'`);
  await keyCombo(page, 'j', 'KeyJ', 74);
  await page.waitFor(`document.querySelector('.workspace').dataset.drawer === 'closed'`);
  await keyCombo(page, ',', 'Comma', 188);
  await page.waitFor(`!!document.querySelector('.settings-sheet[open]')`);
  assert.deepEqual(page.errors, []);
});

test('Cmd/Ctrl+Enter confirms the send dialog but never a destructive one', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.api.settings.setApiKey('deepseek', 'k')`);
  await page.eval(`__ui.click('删除会议')`);
  await page.waitFor(`!!document.querySelector('dialog[open]')`);
  await keyCombo(page, 'Enter', 'Enter', 13);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await page.eval(`__ui.calls['meetings.delete'] ?? 0`), 0);
  await page.eval(`__ui.click('取消')`);

  await page.eval(`__ui.click('重新生成会议纪要')`);
  await page.waitFor(`!!document.querySelector('.generation-consent[open]')`);
  assert.match(
    await page.eval(`document.querySelector('.consent-summary').textContent`),
    /DeepSeek.*4 个转写片段.*不含音频/,
  );
  await keyCombo(page, 'Enter', 'Enter', 13);
  await page.waitFor(`__ui.calls['notes.generate'] >= 1`);
  assert.deepEqual(page.errors, []);
});

test('sidebar width: keyboard resize, persisted, double-click resets', async () => {
  const page = await browser.open();
  const width = `Math.round(document.querySelector('.library').getBoundingClientRect().width)`;
  assert.equal(await page.eval(width), 240);
  await page.eval(`document.querySelector('.sidebar-resizer').focus()`);
  for (let i = 0; i < 3; i += 1) await press(page, 'ArrowRight', 'ArrowRight', 39);
  await page.waitFor(`${width} === 288`);
  assert.equal(await page.eval(`localStorage.getItem('turnnote.sidebarWidth')`), '288');
  assert.equal(
    await page.eval(`document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')`),
    '288',
  );
  for (let i = 0; i < 20; i += 1) await press(page, 'ArrowRight', 'ArrowRight', 39);
  await page.waitFor(`${width} === 320`);
  await page.eval(
    `document.querySelector('.sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
  );
  await page.waitFor(`${width} === 240`);
  assert.deepEqual(page.errors, []);
});

test('dark colour scheme swaps the paper tokens without changing the DOM', async () => {
  const page = await browser.open();
  // 系统主题可能是深色；先固定浅色，才能验证切换而不是假设宿主环境
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  const paper = `getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()`;
  const light = await page.eval(paper);
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await page.waitFor(`${paper} !== ${JSON.stringify(light)}`);
  assert.equal(await page.eval(`matchMedia('(prefers-color-scheme: dark)').matches`), true);
  assert.deepEqual(page.errors, []);
});

test('every interactive control has a visible affordance; tooltips are custom, not native title', async () => {
  const page = await browser.open();
  await openSeeded(page);
  await page.eval(`__ui.click('定位到转写 00:00:05')`);
  await page.waitFor(`document.querySelector('.workspace').dataset.drawer === 'open'`);
  const bare = await page.eval(`(() => {
    // 无框输入包在带边框的外层里；拖拽手柄和关键词 × 是有意的轻量控件
    const allowed = ['field-bare', 'sidebar-resizer', 'chip-remove'];
    const out = [];
    for (const el of document.querySelectorAll('button, select, input, textarea')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || el.matches('.visually-hidden, [type=checkbox]')) continue;
      if (allowed.some((c) => el.classList.contains(c))) continue;
      const cs = getComputedStyle(el);
      const border = cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px';
      const fill = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      if (!border && !fill && cs.boxShadow === 'none')
        out.push((el.getAttribute('aria-label') || el.textContent || el.id).trim().slice(0, 24));
    }
    return out;
  })()`);
  assert.deepEqual(bare, [], `controls without a visible affordance: ${bare.join(', ')}`);

  // 图标按钮用 data-tip；原生 title 只允许出现在非交互的说明文字上
  assert.deepEqual(
    await page.eval(
      `[...document.querySelectorAll('button[title]:not(.reel)')].map((b) => b.title)`,
    ),
    [],
  );
  assert.ok(await page.eval(`document.querySelectorAll('button[data-tip]').length >= 4`));
  assert.deepEqual(page.errors, []);
});

test('both switches are styled and show an explicit on/off word', async () => {
  const page = await browser.open();
  await page.eval(`__ui.type('#meeting-title', 'Switches')`);
  await page.eval(`__ui.click('新建会议')`);
  await page.waitFor(`__ui.status() === '已创建，未开始录音'`);
  assert.equal(await page.eval(`document.querySelectorAll('.switch .switch-track').length`), 2);
  assert.equal(await page.eval(`document.querySelectorAll('.switch-lamp').length`), 0);
  const words = await page.eval(
    `[...document.querySelectorAll('.switch-state')].map((e) => getComputedStyle(e, '::after').content)`,
  );
  assert.equal(words.length, 2);
  for (const word of words) assert.match(word, /["']?[开关]["']?/);
  // 切换一个开关后，状态词同步翻转
  const before = await page.eval(
    `getComputedStyle(document.querySelector('.doc-foot .switch-state'), '::after').content`,
  );
  await page.eval(`document.querySelector('.doc-foot .switch input').click()`);
  await page.waitFor(
    `getComputedStyle(document.querySelector('.doc-foot .switch-state'), '::after').content !== ${JSON.stringify(before)}`,
  );
  assert.deepEqual(page.errors, []);
});
