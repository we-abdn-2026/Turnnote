// 设置里的模型候选：原生 <datalist> 的弹层跟随系统配色（深色系统下是黑框），换成应用内弹层后，
// 验证展开、候选过滤、键盘选择，以及 Escape 只收候选、不关设置面板。
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

async function press(page, key, code, keyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }
}

async function openSettings(page) {
  await page.waitFor(`!!document.querySelector('[aria-label="设置"]')`);
  await page.eval(`document.querySelector('[aria-label="设置"]').click()`);
  await page.waitFor(`!!document.querySelector('#note-model')`);
}

/** 让模型输入拿到焦点并展开候选 */
async function openModel(page) {
  await page.eval(
    `(() => { const el = document.querySelector('#note-model'); el.focus(); el.click(); })()`,
  );
  await page.waitFor(`!!document.querySelector('#note-model-options')`);
}

async function switchTo(page, label) {
  await page.eval(
    `[...document.querySelectorAll('.provider-pick')].find((el) => el.textContent.includes('${label}')).click()`,
  );
  await page.waitFor(`document.querySelector('#note-model').value !== 'deepseek-flash'`);
}

test('模型候选是应用内 listbox，不再是 datalist', async () => {
  const page = await browser.open();
  await openSettings(page);
  assert.equal(await page.eval(`!!document.querySelector('datalist')`), false);
  await openModel(page);
  assert.equal(
    await page.eval(`document.querySelector('#note-model').getAttribute('aria-expanded')`),
    'true',
  );
  assert.equal(
    await page.eval(`document.querySelector('#note-model-options').getAttribute('role')`),
    'listbox',
  );
  assert.deepEqual(
    await page.eval(`[...document.querySelectorAll('.model-option')].map((el) => el.textContent)`),
    ['deepseek-flash'],
  );
});

test('方向键高亮候选，回车选中并收起，Escape 只收候选不关设置', async () => {
  const page = await browser.open();
  await openSettings(page);
  await switchTo(page, 'OpenAI');
  await openModel(page);
  assert.deepEqual(
    await page.eval(`[...document.querySelectorAll('.model-option')].map((el) => el.textContent)`),
    ['gpt-4o', 'gpt-4o-mini'],
  );

  await press(page, 'ArrowDown', 'ArrowDown', 40);
  await press(page, 'ArrowDown', 'ArrowDown', 40);
  assert.equal(
    await page.eval(`document.querySelector('.model-option[data-active="true"]').textContent`),
    'gpt-4o-mini',
  );
  await press(page, 'Enter', 'Enter', 13);
  assert.equal(await page.eval(`document.querySelector('#note-model').value`), 'gpt-4o-mini');
  assert.equal(await page.eval(`!!document.querySelector('#note-model-options')`), false);
  // 改动了模型才出现保存按钮，回车选中不会顺手提交
  await page.waitFor(
    `[...document.querySelectorAll('button')].some((el) => el.textContent.includes('保存模型'))`,
  );

  await openModel(page);
  await press(page, 'Escape', 'Escape', 27);
  assert.equal(await page.eval(`!!document.querySelector('#note-model-options')`), false);
  assert.equal(await page.eval(`!!document.querySelector('dialog[open]')`), true);
  await press(page, 'Escape', 'Escape', 27);
  await page.waitFor(`!document.querySelector('dialog[open]')`);
});

test('输入按模型名过滤候选', async () => {
  const page = await browser.open();
  await openSettings(page);
  await switchTo(page, 'OpenAI');
  await page.eval(
    `(() => { const el = document.querySelector('#note-model'); el.focus(); el.setSelectionRange(0, el.value.length); })()`,
  );
  await page.send('Input.insertText', { text: 'mini' });
  await page.waitFor(`!!document.querySelector('#note-model-options')`);
  assert.deepEqual(
    await page.eval(`[...document.querySelectorAll('.model-option')].map((el) => el.textContent)`),
    ['gpt-4o-mini'],
  );
  assert.equal(await page.eval(`document.querySelector('#note-model').value`), 'mini');
});
