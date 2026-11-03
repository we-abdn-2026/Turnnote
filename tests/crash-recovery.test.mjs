/**
 * #37 崩溃恢复：中断录音 / 转写 / 生成后重启，以及删除续删与清理中断收敛。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  SAMPLE_SEGMENTS,
  SAMPLE_WAV,
  createMainSession,
  delay,
  hangingSidecar,
  succeedingSidecar,
  until,
  value,
} from './support/main-session.mjs';

test('interrupted recording is repaired on restart, kept for retry, and never auto-transcribed', async (t) => {
  const env = await createMainSession(t, { sidecar: () => succeedingSidecar() });
  const created = value(await env.api.meetings.create('Interrupted mic'));
  const started = value(await env.api.recording.start(created.id));
  value(
    await env.api.recording.appendChunk(
      created.id,
      started.activeJobId,
      Int16Array.from({ length: 3200 }, (_, i) => i - 1600),
    ),
  );
  const audio = env.store.getAudio(created.id);
  assert.ok(audio);
  // 不 stop：模拟崩溃时 header 仍是占位
  const raw = readFileSync(audio.filePath);
  assert.ok(raw.length > 44);

  const restarted = await env.reopen({ sidecar: () => succeedingSidecar() });
  const meeting = restarted.store.get(created.id);
  assert.equal(meeting.status, 'failed');
  assert.equal(meeting.lastError.code, 'INTERRUPTED');
  assert.equal(meeting.lastError.kind, 'recording');
  assert.equal(meeting.hasAudio, true);
  // WAV 已修复为合法长度
  const repaired = readFileSync(audio.filePath);
  assert.equal(repaired.toString('ascii', 0, 4), 'RIFF');
  assert.equal(repaired.readUInt32LE(40) % 2, 0);
  assert.ok(repaired.readUInt32LE(40) > 0);
  // 不自动转写
  await delay(80);
  assert.equal(
    restarted.store.getJobs(created.id).filter((j) => j.kind === 'transcribing').length,
    0,
  );
  // 可显式丢弃后重录
  value(await restarted.api.recording.cancel(created.id, meeting.lastError.jobId));
  assert.equal(restarted.status(created.id), 'created');
});

test('interrupted transcription becomes failed/INTERRUPTED, keeps audio and segments empty, then retries', async (t) => {
  const env = await createMainSession(t, { sidecar: () => hangingSidecar(60_000) });
  const meeting = env.captured('Hung ASR', SAMPLE_WAV);
  value(await env.api.transcription.start(meeting.id));
  await until(() => env.store.get(meeting.id).status === 'transcribing', 'enter transcribing');
  const jobId = env.store.get(meeting.id).activeJobId;

  const restarted = await env.reopen({ sidecar: () => succeedingSidecar() });
  const after = restarted.store.get(meeting.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.lastError.code, 'INTERRUPTED');
  assert.equal(after.lastError.kind, 'transcribing');
  assert.equal(after.hasAudio, true);
  assert.deepEqual(restarted.store.getSegments(meeting.id), []);
  assert.equal(restarted.store.getJob(jobId).status, 'failed');

  value(await restarted.api.transcription.start(meeting.id));
  await until(() => restarted.status(meeting.id) === 'transcribed', 'retry transcription');
  assert.ok(restarted.store.getSegments(meeting.id).length > 0);
});

test('interrupted generation keeps user edits and transcript; retry produces a new version', async (t) => {
  const env = await createMainSession(t, {
    sidecar: () => succeedingSidecar(),
    providerTimeoutMs: 30_000,
  });
  const meeting = env.captured('Hung notes', SAMPLE_WAV);
  const job = env.store.beginTranscription(meeting.id);
  env.store.completeTranscription(job.id, SAMPLE_SEGMENTS);
  // 用户先存一版
  value(
    await env.api.notes.saveEdit(
      meeting.id,
      {
        summary: 'Edit before crash',
        keyTopics: ['Keep'],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      0,
    ),
  );
  // 让 mock 挂住
  env.setMode('timeout', 60_000);
  const started = value(await env.api.notes.generate(meeting.id));
  await until(() => env.status(meeting.id) === 'generating', 'enter generating');

  const restarted = await env.reopen({
    sidecar: () => succeedingSidecar(),
    providerTimeoutMs: 30_000,
  });
  const after = restarted.store.get(meeting.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.lastError.code, 'INTERRUPTED');
  assert.equal(after.lastError.kind, 'generating');
  assert.equal(
    value(await restarted.api.notes.getLatest(meeting.id)).note.summary,
    'Edit before crash',
  );
  assert.deepEqual(restarted.store.getSegments(meeting.id), SAMPLE_SEGMENTS);
  assert.equal(restarted.store.getJob(started.activeJobId).status, 'failed');

  restarted.setMode('normal');
  value(await restarted.api.notes.generate(meeting.id));
  await until(() => restarted.status(meeting.id) === 'ready', 'retry generation');
  const latest = value(await restarted.api.notes.getLatest(meeting.id));
  assert.equal(latest.source, 'generated');
  assert.ok(latest.version > 1);
});

test('a failed deletion keeps a hidden tombstone across restart and finishes on the next pass', async (t) => {
  const env = await createMainSession(t, { sidecar: () => succeedingSidecar() });
  // 用目录冒充音频路径 → unlink 失败
  const dirPath = join(env.audioDirectory, 'blocked-dir.wav');
  mkdirSync(dirPath);
  const id = env.store.createCaptured('Stuck delete', dirPath).id;
  const result = await env.api.meetings.delete(id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WRITE_FAILED');
  assert.deepEqual(env.store.list(), []);
  assert.equal(env.store.getDeleted()[0].id, id);

  const restarted = await env.reopen({ sidecar: () => succeedingSidecar() });
  // recover 会再次尝试 delete；目录仍在 → 仍失败，墓碑保留
  assert.deepEqual(restarted.store.list(), []);
  assert.equal(restarted.store.getDeleted()[0]?.id, id);
  assert.throws(
    () => restarted.store.get(id),
    (e) => e.code === 'NOT_FOUND',
  );

  rmSync(dirPath, { recursive: true });
  const final = await restarted.reopen({ sidecar: () => succeedingSidecar() });
  assert.deepEqual(final.store.getDeleted(), []);
  assert.deepEqual(final.store.list(), []);
});

test('cleanup interrupted after unlink but before dropping the reference converges on recover', async (t) => {
  const env = await createMainSession(t, { sidecar: () => succeedingSidecar() });
  const meeting = env.captured('Half cleaned', SAMPLE_WAV);
  const job = env.store.beginTranscription(meeting.id);
  env.store.completeTranscription(job.id, SAMPLE_SEGMENTS);
  // 模拟「文件已删、引用还在」
  const audio = env.store.getAudio(meeting.id);
  assert.ok(audio);
  unlinkSync(audio.filePath);
  assert.equal(env.store.get(meeting.id).hasAudio, true);

  const restarted = await env.reopen({ sidecar: () => succeedingSidecar() });
  // recover → retention.sweep → ENOENT 视为成功并清引用
  assert.equal(restarted.store.get(meeting.id).hasAudio, false);
  assert.equal(restarted.store.getAudio(meeting.id), null);
  assert.deepEqual(restarted.store.getSegments(meeting.id), SAMPLE_SEGMENTS);
  assert.equal(existsSync(audio.filePath), false);
});

test('shutdown mid-transcription persists INTERRUPTED without orphan jobs or leftover child ownership', async (t) => {
  const env = await createMainSession(t, { sidecar: () => hangingSidecar(60_000) });
  const meeting = env.captured('Shutdown ASR', SAMPLE_WAV);
  const started = value(await env.api.transcription.start(meeting.id));
  await until(() => env.status(meeting.id) === 'transcribing');
  await env.services.shutdown();
  assert.equal(env.store.get(meeting.id).status, 'failed');
  assert.equal(env.store.get(meeting.id).lastError.code, 'INTERRUPTED');
  assert.equal(env.store.getJob(started.activeJobId).status, 'failed');
  // 关闭后不能再开新任务
  assert.equal((await env.api.transcription.start(meeting.id)).error.code, 'INTERRUPTED');
});

test('startup recovery is idempotent across repeated reopen cycles', async (t) => {
  const env = await createMainSession(t, { sidecar: () => hangingSidecar() });
  const meeting = env.captured('Idempotent', SAMPLE_WAV);
  value(await env.api.transcription.start(meeting.id));
  await until(() => env.status(meeting.id) === 'transcribing');

  let current = env;
  for (let i = 0; i < 3; i++) {
    current = await current.reopen({ sidecar: () => succeedingSidecar() });
    const m = current.store.get(meeting.id);
    assert.equal(m.status, 'failed');
    assert.equal(m.lastError.code, 'INTERRUPTED');
    const running = current.store
      .getJobs(meeting.id)
      .filter((j) => j.status === 'running' || j.status === 'pending');
    assert.deepEqual(running, []);
  }
});
