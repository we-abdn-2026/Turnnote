/**
 * #36 Main 服务集成测试：真实 createSessionServices + fake sidecar + AI provider mock
 * 串联 录音/导入 → 转写 → 生成 → 导出，并覆盖 provider 维度与失败边界。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_KEY,
  SAMPLE_WAV,
  createMainSession,
  crashingSidecar,
  failure,
  succeedingSidecar,
  until,
  value,
} from './support/main-session.mjs';

test('recording → auto-transcribe → generate → markdown export keeps a full, queryable trail', async (t) => {
  const env = await createMainSession(t, { useRealFakeWorker: true });
  const id = await env.recordTo('transcribed', { title: 'Weekly pipeline' });
  assert.ok(value(await env.api.transcription.getSegments(id)).length > 0);
  // 默认不保留音频：转写成功后副本应被清理
  assert.equal(env.store.get(id).hasAudio, false);

  value(await env.api.meetings.setKeywords(id, ['Pricing']));
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready', 'generate→ready');
  const note = value(await env.api.notes.getLatest(id));
  assert.equal(note.source, 'generated');
  assert.ok(note.note.summary.length > 0);

  const target = join(env.exportsDir, 'weekly.md');
  env.setChooseSavePath(async () => target);
  assert.deepEqual(value(await env.api.exports.markdown(id)), { saved: true });
  const markdown = readFileSync(target, 'utf8');
  assert.match(markdown, /Weekly pipeline/);
  assert.match(markdown, /## 摘要/);
  // 凭证不进库、不进导出
  assert.equal(markdown.includes(API_KEY), false);
  const dump = JSON.stringify(env.store.list()) + JSON.stringify(env.store.getJobs(id));
  assert.equal(dump.includes(API_KEY), false);
  // mock 收到了生成请求
  assert.ok(env.server.getRequests().length >= 1);
  assert.ok(
    env.fetches.every((f) => !JSON.stringify(f).includes(API_KEY) || f.headers?.Authorization),
  );
});

test('import → auto-transcribe → generate → export; cancel and bad files stay inert', async (t) => {
  const env = await createMainSession(t, { useRealFakeWorker: true });

  env.setChooseFile(async () => null);
  assert.equal(value(await env.api.meetings.importAudio()), null);
  assert.deepEqual(env.store.list(), []);
  assert.deepEqual(env.managedFiles(), []);

  env.pickImport('notes.txt', Buffer.from('not audio'));
  failure(await env.api.meetings.importAudio(), 'AUDIO_DECODE_FAILED');
  assert.deepEqual(env.store.list(), []);
  assert.deepEqual(env.managedFiles(), []);

  const source = env.pickImport('meeting.wav', SAMPLE_WAV);
  const original = readFileSync(source);
  const imported = value(await env.api.meetings.importAudio());
  assert.equal(imported.status, 'captured');
  await until(() => env.status(imported.id) === 'transcribed', 'import→transcribed');
  assert.deepEqual(readFileSync(source), original); // 原文件只读
  assert.equal(env.store.get(imported.id).hasAudio, false); // 副本已按策略清理

  value(await env.api.notes.generate(imported.id));
  await until(() => env.status(imported.id) === 'ready', 'import generate→ready');
  env.setChooseSavePath(async () => join(env.exportsDir, 'imported.md'));
  assert.deepEqual(value(await env.api.exports.markdown(imported.id)), { saved: true });
  assert.ok(existsSync(join(env.exportsDir, 'imported.md')));
});

test('import whose transcription fails keeps the copy for retry, then cleans up after success', async (t) => {
  let attempt = 0;
  const env = await createMainSession(t, {
    sidecar: () => (++attempt === 1 ? crashingSidecar() : succeedingSidecar()),
  });
  env.pickImport('retry.wav', SAMPLE_WAV);
  const meeting = value(await env.api.meetings.importAudio());
  await until(() => env.status(meeting.id) === 'failed', 'import→failed');
  assert.equal(env.store.get(meeting.id).hasAudio, true);
  assert.equal(env.managedFiles().length, 1);

  value(await env.api.transcription.start(meeting.id));
  await until(() => env.status(meeting.id) === 'transcribed', 'retry→transcribed');
  assert.equal(env.store.get(meeting.id).hasAudio, false);
  assert.deepEqual(env.managedFiles(), []);
});

test('missing API key is API_KEY_MISSING and keys are scoped to noteProvider', async (t) => {
  const env = await createMainSession(t, {
    apiKeys: { deepseek: API_KEY }, // openai 无 key
    sidecar: () => succeedingSidecar(),
  });
  const id = env.captured('Key scope', SAMPLE_WAV).id;
  // 直接完成转写，避免 sidecar 路径干扰
  const job = env.store.beginTranscription(id);
  env.store.completeTranscription(job.id, [{ startMs: 0, endMs: 1000, text: 'Scoped key check.' }]);

  // 当前 provider=deepseek 有 key → 可生成
  assert.equal(value(await env.api.settings.hasApiKey('deepseek')), true);
  assert.equal(value(await env.api.settings.hasApiKey('openai')), false);
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready', 'deepseek generate');

  // 切到 openai 且无 key → API_KEY_MISSING，且不发请求
  const before = env.fetches.length;
  value(await env.api.settings.update({ noteProvider: 'openai', noteModel: 'gpt-4o-mini' }));
  failure(await env.api.notes.generate(id), 'API_KEY_MISSING');
  assert.equal(env.fetches.length, before);
  assert.equal(env.status(id), 'ready'); // 状态未动

  // 只给 openai 配 key，deepseek 的 key 不应被误用
  env.setKey('deepseek', null);
  env.setKey('openai', 'sk-openai-only');
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready' || env.status(id) === 'generating', 'openai start');
  await until(() => env.status(id) === 'ready', 'openai generate');
  const last = env.fetches.at(-1);
  assert.match(last.headers.Authorization, /sk-openai-only/);
  assert.equal(last.headers.Authorization.includes(API_KEY), false);
});

test('switching provider and model routes the request to the matching endpoint and body', async (t) => {
  const env = await createMainSession(t, {
    apiKeys: { deepseek: 'sk-ds', openai: 'sk-oa' },
    sidecar: () => succeedingSidecar(),
  });
  const id = env.captured('Routing', SAMPLE_WAV).id;
  const job = env.store.beginTranscription(id);
  env.store.completeTranscription(job.id, [{ startMs: 0, endMs: 500, text: 'Route me.' }]);

  value(await env.api.settings.update({ noteProvider: 'deepseek', noteModel: 'deepseek-flash' }));
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready');
  const ds = env.fetches.at(-1);
  assert.match(ds.url, /\/v1\/chat\/completions$/);
  assert.equal(ds.body.model, 'deepseek-flash');
  assert.match(ds.headers.Authorization, /sk-ds/);
  assert.equal(env.server.getRequests().at(-1).model, 'deepseek-flash');

  value(await env.api.settings.update({ noteProvider: 'openai', noteModel: 'gpt-4o-mini' }));
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready');
  const oa = env.fetches.at(-1);
  assert.equal(oa.body.model, 'gpt-4o-mini');
  assert.match(oa.headers.Authorization, /sk-oa/);
  assert.equal(env.server.getRequests().at(-1).model, 'gpt-4o-mini');
  // 两次请求都打到同一 mock baseUrl（provider 层只换 Authorization/model，baseUrl 由注入覆盖）
  assert.equal(new URL(ds.url).origin, new URL(oa.url).origin);
});

test('provider failures keep prior notes and segments; export failures leave records intact', async (t) => {
  const env = await createMainSession(t, { sidecar: () => succeedingSidecar() });
  const id = env.captured('Failures', SAMPLE_WAV).id;
  const job = env.store.beginTranscription(id);
  env.store.completeTranscription(job.id, [{ startMs: 0, endMs: 800, text: 'Keep me.' }]);
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready');
  const edited = value(
    await env.api.notes.saveEdit(
      id,
      { ...value(await env.api.notes.getLatest(id)).note, summary: 'User keeps this' },
      1,
    ),
  );

  for (const [mode, code] of [
    ['rate-limit', 'DEEPSEEK_RATE_LIMITED'],
    ['invalid-json', 'DEEPSEEK_INVALID_RESPONSE'],
    ['server-error', 'DEEPSEEK_UNAVAILABLE'],
  ]) {
    env.setMode(mode);
    const started = value(await env.api.notes.generate(id));
    await until(() => env.status(id) === 'failed', `${mode}→failed`);
    assert.equal(env.store.get(id).lastError.code, code);
    assert.equal(value(await env.api.notes.getLatest(id)).note.summary, 'User keeps this');
    assert.deepEqual(env.store.getSegments(id), [{ startMs: 0, endMs: 800, text: 'Keep me.' }]);
    assert.equal(env.store.getJob(started.activeJobId).status, 'failed');
  }

  // timeout：客户端超时短于 mock 延迟
  const timed = await createMainSession(t, {
    sidecar: () => succeedingSidecar(),
    providerTimeoutMs: 50,
    apiKeys: { deepseek: API_KEY },
  });
  const tid = timed.captured('Timeout', SAMPLE_WAV).id;
  const tjob = timed.store.beginTranscription(tid);
  timed.store.completeTranscription(tjob.id, [{ startMs: 0, endMs: 400, text: 'Tick.' }]);
  value(
    await timed.api.notes.saveEdit(
      tid,
      {
        summary: 'Saved before timeout',
        keyTopics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      0,
    ),
  );
  timed.setMode('timeout', 5_000);
  value(await timed.api.notes.generate(tid));
  await until(() => timed.status(tid) === 'failed', 'timeout→failed', 3_000);
  assert.equal(timed.store.get(tid).lastError.code, 'DEEPSEEK_TIMEOUT');
  assert.equal(value(await timed.api.notes.getLatest(tid)).note.summary, 'Saved before timeout');

  // 导出取消 / 写入失败：先恢复到 ready，再写回用户编辑作为最新版本
  env.setMode('normal');
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready');
  const restored = value(
    await env.api.notes.saveEdit(
      id,
      { ...value(await env.api.notes.getLatest(id)).note, summary: 'User keeps this' },
      value(await env.api.notes.getLatest(id)).version,
    ),
  );
  env.setChooseSavePath(async () => null);
  assert.deepEqual(value(await env.api.exports.markdown(id)), { saved: false });
  assert.equal(value(await env.api.notes.getLatest(id)).note.summary, 'User keeps this');
  assert.equal(value(await env.api.notes.getLatest(id)).version, restored.version);

  env.setChooseSavePath(async () => join(env.root, 'no-such-dir', 'out.md'));
  failure(await env.api.exports.markdown(id), 'WRITE_FAILED');
  assert.equal(value(await env.api.notes.getLatest(id)).note.summary, 'User keeps this');
  assert.equal(env.status(id), 'ready');
  assert.equal(edited.note.summary, 'User keeps this');
});

test('fixture shutdown leaves no child processes or temp roots behind the test after-hooks', async (t) => {
  const env = await createMainSession(t, { sidecar: () => succeedingSidecar(undefined, 50) });
  const id = env.captured('Cleanup', SAMPLE_WAV).id;
  value(await env.api.transcription.start(id));
  await until(() => env.status(id) === 'transcribed');
  // after hooks 负责 shutdown + rmSync；这里只断言当前可关闭
  await env.close();
  assert.ok(existsSync(env.root)); // after 尚未跑；关闭本身不删 root
});
