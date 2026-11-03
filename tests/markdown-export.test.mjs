import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDispatcher,
  createExportHandlers,
  createSessionServices,
  markdownFileName,
  MeetingStore,
  renderMeetingMarkdown,
} from '../out/tests/runtime.mjs';

const MEETING = { title: '周会：发布 & 定价 #1', createdAt: '2026-11-03T02:20:00.000Z' };
const NOTE = {
  summary:
    '本周讨论了发布计划。\n第二行：定价 *待定*。\n\n# 不是标题\n- 不是列表\n1. 不是编号\n> 不是引用\n===\n<script>alert(1)</script>',
  keyTopics: ['发布计划', 'C# 与 snake_case', '  '],
  decisions: [
    { text: '周五发布 beta\n（含换行）', timestampMs: 2400 },
    { text: '定价 [待议](http://x)' },
  ],
  openQuestions: ['价格是多少？'],
  actionItems: [
    { task: '准备发布说明', owner: 'Alex', dueDate: '2026-11-07', timestampMs: 5200 },
    { task: '调研竞品 `pricing`', owner: 'unspecified', dueDate: '' },
  ],
};
// 入库的纪要必须通过存储层 schema（owner/dueDate 不能为空串）；渲染器对空串另有防御测试。
const STORED_NOTE = {
  ...NOTE,
  actionItems: NOTE.actionItems.map((item) => ({
    ...item,
    dueDate: item.dueDate || 'unspecified',
  })),
};
const SEGMENTS = [{ startMs: 0, endMs: 1000, text: 'Controlled audio' }];
const render = (note = NOTE, meeting = MEETING) =>
  renderMeetingMarkdown(meeting, note, { timeZone: 'UTC' });
const errorCode = (code) => (error) => error.code === code;

test('output matches the reviewed sample byte for byte (Chinese, multi-line, special characters)', () => {
  const expected = readFileSync(new URL('./fixtures/exported-meeting.md', import.meta.url), 'utf8');
  assert.equal(render(), expected);
});

test('only the expected headings exist and no user text can open markup or HTML', () => {
  const output = render();
  const headings = output.split('\n').filter((line) => /^#{1,6}\s/.test(line));
  assert.deepEqual(headings, [
    '# 周会：发布 & 定价 \\#1',
    '## 摘要',
    '## 关键主题',
    '## 决策',
    '## 未决问题',
    '## 行动项',
  ]);
  // 用户文本里的 < > 全部带反斜杠；没有裸露的 HTML 标签、引用或列表起始
  assert.equal(/(^|[^\\])[<>]/m.test(output), false);
  const body = output.split('## 摘要')[1].split('## 关键主题')[0];
  for (const line of body.split('\n').filter(Boolean)) {
    assert.equal(/^(#|[-+>]|=+$|\d+[.)]\s)/.test(line), false, line);
  }
});

test('hostile titles stay on one line; hard breaks keep summary lines together', () => {
  const output = render(NOTE, { ...MEETING, title: '  Line one\r\nLine *two*\u0000 #  ' });
  assert.equal(output.split('\n')[0], '# Line one Line \\*two\\* \\#');
  assert.match(render(), /本周讨论了发布计划。 {2}\n第二行/);
});

test('empty sections, blank values and unspecified owners render the same placeholders as the UI', () => {
  const output = render({
    summary: '   ',
    keyTopics: [],
    decisions: [],
    openQuestions: [],
    actionItems: [{ task: '  ', owner: ' Unspecified ', dueDate: '' }],
  });
  assert.match(output, /## 摘要\n\n未填写\n/);
  for (const heading of ['关键主题', '决策', '未决问题']) {
    assert.match(output, new RegExp(`## ${heading}\\n\\n未指定\\n`));
  }
  assert.match(output, /1\. 未指定\n {3}- 负责人：未指定\n {3}- 截止时间：未指定\n$/);
});

test('sub-lists stay attached to their item once numbering reaches two digits', () => {
  const actionItems = Array.from({ length: 11 }, (_, i) => ({
    task: `Task ${i + 1}`,
    owner: 'Sam',
    dueDate: 'unspecified',
  }));
  const output = render({ ...NOTE, actionItems });
  assert.match(output, /\n10\. Task 10\n {4}- 负责人：Sam\n {4}- 截止时间：未指定\n/);
  assert.match(output, /\n9\. Task 9\n {3}- 负责人：Sam/);
});

test('invalid creation time degrades to a placeholder instead of throwing', () => {
  assert.match(render(NOTE, { ...MEETING, createdAt: 'not a date' }), /- 时间：未指定/);
});

test('default file names drop separators and reserved names, and always end with .md', () => {
  assert.equal(markdownFileName('周会：发布/定价'), '周会：发布 定价.md');
  assert.equal(markdownFileName('a\\b:c*?"<>|d'), 'a b c d.md');
  assert.equal(markdownFileName('  ...  '), '会议纪要.md');
  assert.equal(markdownFileName('CON'), '_CON.md');
  assert.equal(markdownFileName('x'.repeat(200)), `${'x'.repeat(80)}.md`);
  assert.equal(markdownFileName('名'.repeat(100)), `${'名'.repeat(80)}.md`);
});

function fixture(t, chooseSavePath) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-export-')));
  const audioDirectory = join(root, 'audio');
  mkdirSync(audioDirectory);
  const store = new MeetingStore(join(root, 'turnnote.db'), audioDirectory);
  const requested = [];
  const handlers = createExportHandlers(store, {
    timeZone: 'UTC',
    chooseSavePath: async (name) => {
      requested.push(name);
      return chooseSavePath(name);
    },
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function ready(title = 'Weekly sync') {
    const path = join(audioDirectory, `${title}.wav`);
    writeFileSync(path, 'audio');
    const id = store.createCaptured(title, path).id;
    const job = store.beginTranscription(id);
    store.completeTranscription(job.id, SEGMENTS);
    const generation = store.beginGeneration(id);
    store.completeGeneration(generation.id, STORED_NOTE);
    return id;
  }
  return { root, store, handlers, requested, ready };
}

test('export writes the latest saved edit, not the generated draft', async (t) => {
  const f = fixture(t, () => join(f.root, 'out.md'));
  const id = f.ready();
  f.store.saveEdit(id, { ...STORED_NOTE, summary: '用户改过的摘要' }, 1);
  assert.deepEqual(await f.handlers.markdown(id), { ok: true, value: { saved: true } });
  const written = readFileSync(join(f.root, 'out.md'), 'utf8');
  assert.match(written, /用户改过的摘要/);
  assert.doesNotMatch(written, /本周讨论了发布计划/);
  assert.deepEqual(f.requested, ['Weekly sync.md']);
  assert.deepEqual(
    readdirSync(f.root).filter((name) => name.includes('.tmp')),
    [],
  );
});

test('an edit saved while the dialog is open is what gets exported', async (t) => {
  const f = fixture(t, () => {
    f.store.saveEdit(id, { ...STORED_NOTE, summary: '对话框期间保存的编辑' }, 1);
    return join(f.root, 'late.md');
  });
  const id = f.ready();
  await f.handlers.markdown(id);
  assert.match(readFileSync(join(f.root, 'late.md'), 'utf8'), /对话框期间保存的编辑/);
});

test('cancelling returns saved:false and writes nothing', async (t) => {
  const f = fixture(t, () => null);
  const id = f.ready();
  assert.deepEqual(await f.handlers.markdown(id), { ok: true, value: { saved: false } });
  assert.deepEqual(
    readdirSync(f.root).sort(),
    ['audio', 'turnnote.db', 'turnnote.db-shm', 'turnnote.db-wal'].filter((name) =>
      existsSync(join(f.root, name)),
    ),
  );
});

test('a meeting without a note fails before any dialog opens; missing meetings are NOT_FOUND', async (t) => {
  const f = fixture(t, () => assert.fail('dialog must not open'));
  const path = join(f.root, 'audio', 'a.wav');
  writeFileSync(path, 'audio');
  const captured = f.store.createCaptured('No note', path).id;
  await assert.rejects(f.handlers.markdown(captured), errorCode('INVALID_STATE'));
  await assert.rejects(f.handlers.markdown('missing'), errorCode('NOT_FOUND'));
  assert.deepEqual(f.requested, []);
});

test('write failures report WRITE_FAILED, keep the meeting untouched and never truncate an existing file', async (t) => {
  const f = fixture(t, () => join(f.root, 'no-such-directory', 'out.md'));
  const id = f.ready();
  const before = f.store.getLatestNote(id);
  await assert.rejects(f.handlers.markdown(id), errorCode('WRITE_FAILED'));
  assert.deepEqual(f.store.getLatestNote(id), before);
  assert.equal(f.store.get(id).status, 'ready');

  // 目标是目录：rename 失败，临时文件被清理，目录内容不变
  const target = join(f.root, 'taken');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'keep');
  const g = fixture(t, () => target);
  await assert.rejects(g.handlers.markdown(g.ready()), errorCode('WRITE_FAILED'));
  assert.deepEqual(readdirSync(target), ['keep.txt']);
  assert.deepEqual(
    readdirSync(g.root).filter((name) => name.includes('.tmp')),
    [],
  );
});

test('a relative path from the dialog is refused', async (t) => {
  const f = fixture(t, () => 'relative.md');
  await assert.rejects(f.handlers.markdown(f.ready()), errorCode('WRITE_FAILED'));
});

test('overwriting an existing file replaces it completely', async (t) => {
  const f = fixture(t, () => join(f.root, 'existing.md'));
  writeFileSync(
    join(f.root, 'existing.md'),
    'old content, much longer than the new one '.repeat(500),
  );
  const id = f.ready();
  await f.handlers.markdown(id);
  const expected = renderMeetingMarkdown(f.store.get(id), STORED_NOTE, { timeZone: 'UTC' });
  assert.equal(readFileSync(join(f.root, 'existing.md'), 'utf8'), expected);
});

test('Main composition registers exports only when a dialog is provided, through the shared IPC validation', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-export-session-')));
  const audioDirectory = join(root, 'audio');
  mkdirSync(audioDirectory);
  const store = new MeetingStore(join(root, 'turnnote.db'), audioDirectory);
  const base = {
    audioDirectory,
    modelsDirectory: join(root, 'models'),
    sidecar: () => assert.fail('sidecar must not start'),
    permissions: () => ({ microphone: 'unknown', screen: 'unknown' }),
    emitMeeting: () => {},
    emitProgress: () => {},
  };
  const without = createSessionServices(store, base);
  const withDialog = createSessionServices(store, {
    ...base,
    exports: { chooseSavePath: async () => null },
  });
  t.after(async () => {
    await without.shutdown();
    await withDialog.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(
    (await createDispatcher(without.handlers)('exports:markdown', ['abc'])).error.code,
    'NOT_IMPLEMENTED',
  );
  const dispatch = createDispatcher(withDialog.handlers);
  assert.equal((await dispatch('exports:markdown', ['abc'])).error.code, 'NOT_FOUND');
  assert.equal((await dispatch('exports:markdown', [])).error.code, 'INVALID_INPUT');
});
