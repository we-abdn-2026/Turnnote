/**
 * 一场会议的多段录音：暂停后继续、对已转写的会议追加。
 * 真实 createSessionServices + 本地 sidecar stub；覆盖时间线偏移、纪要过期、保留策略、
 * 取消/失败/崩溃恢复和历史数据迁移。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore, migrate, migrations } from '../out/tests/runtime.mjs';
import {
  createMainSession,
  crashingSidecar,
  failure,
  succeedingSidecar,
  until,
  value,
} from './support/main-session.mjs';

/** 每段音频：两个片段，整段时长 5 秒（结尾有 1 秒静音，用来证明偏移用的是音频时长而不是最后片段的结束） */
const PART = [
  { startMs: 0, endMs: 2000, text: 'first sentence' },
  { startMs: 2000, endMs: 4000, text: 'second sentence' },
];
const PART_DURATION = 5000;
const part = () => succeedingSidecar(PART, 0, PART_DURATION);
const shifted = (offset) =>
  PART.map((segment) => ({
    ...segment,
    startMs: segment.startMs + offset,
    endMs: segment.endMs + offset,
  }));

test('continuing a meeting appends the next recording after the previous one, in time', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed', { title: 'Two parts' });
  assert.deepEqual(env.store.getSegments(id), PART);
  assert.equal(env.store.getTimelineMs(id), PART_DURATION);

  const job = await env.recordPart(id, { until: 'transcribed' });
  assert.equal(env.store.getJob(job).status, 'completed');
  // 第二段的时间接在第一段的音频时长之后（5000），而不是最后一个片段的结束（4000）
  assert.deepEqual(env.store.getSegments(id), [...PART, ...shifted(PART_DURATION)]);
  assert.equal(env.store.getTimelineMs(id), PART_DURATION * 2);

  // 第三段继续接上
  await env.recordPart(id, { until: 'transcribed' });
  assert.deepEqual(env.store.getSegments(id).slice(-2), shifted(PART_DURATION * 2));
  assert.equal(env.store.getSegments(id).length, 6);
  const jobs = env.store.getJobs(id);
  assert.deepEqual(
    jobs.filter((j) => j.kind === 'recording').map((j) => j.attempt),
    [1, 2, 3],
  );
  assert.ok(jobs.every((j) => j.status === 'completed'));
});

test('a meeting passes through the normal states again when a part is appended', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  const before = env.events.length;
  await env.recordPart(id, { until: 'transcribed' });
  const statuses = env.events
    .slice(before)
    .filter((meeting) => meeting.id === id)
    .map((meeting) => meeting.status);
  assert.deepEqual(statuses, ['recording', 'captured', 'transcribing', 'transcribed']);
  assert.equal(
    env.store.get(id).hasAudio,
    false,
    'default policy: transcribed audio is cleaned up',
  );
});

test('appending to a meeting with notes marks the note stale; the note itself is untouched; regenerating clears it', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready', 'first note');
  const first = value(await env.api.notes.getLatest(id));
  assert.equal(env.store.get(id).noteStale, false);
  assert.equal(env.store.list().find((m) => m.id === id).noteStale, false);

  await env.recordPart(id, { until: 'ready' });
  // 已有纪要保持不变，但被标记为没有包含新内容
  assert.deepEqual(value(await env.api.notes.getLatest(id)), first);
  assert.equal(env.store.get(id).noteStale, true);
  assert.equal(env.store.list().find((m) => m.id === id).noteStale, true);
  assert.equal(value(await env.api.meetings.get(id)).noteStale, true);

  // 重新生成基于全部转写，生成后不再过期；旧版本保留
  value(await env.api.notes.generate(id));
  await until(
    () => env.status(id) === 'ready' && env.store.getLatestNote(id).version === 2,
    'regenerated',
  );
  assert.equal(env.store.get(id).noteStale, false);
  assert.equal(env.store.list().find((m) => m.id === id).noteStale, false);
  const sent = JSON.stringify(env.server.getRequests().at(-1).messages);
  assert.match(sent, /first sentence/);
  assert.match(sent, /\[5000\] first sentence/, 'the appended part is part of the transcript sent');
});

test('a part with no recognised speech advances the timeline but does not make the note stale', async (t) => {
  let call = 0;
  const env = await createMainSession(t, {
    // 第二段是静音：整段 3 秒，没有任何片段
    sidecar: () => (++call === 2 ? succeedingSidecar([], 0, 3000) : part()),
  });
  const id = await env.recordTo('transcribed');
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready', 'note');

  await env.recordPart(id, { until: 'ready' });
  assert.equal(env.store.get(id).noteStale, false, 'nothing was added to the transcript');
  assert.deepEqual(env.store.getSegments(id), PART);
  assert.equal(env.store.getTimelineMs(id), PART_DURATION + 3000);

  // 之后的第三段接在静音之后：偏移包含那 3 秒
  await env.recordPart(id, { until: 'ready' });
  assert.deepEqual(env.store.getSegments(id).slice(-2), shifted(PART_DURATION + 3000));
  assert.equal(env.store.get(id).noteStale, true);
});

test('editing a stale note does not make it fresh; a meeting without a note is never stale', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  assert.equal(env.store.get(id).noteStale, false, 'no note yet');
  await env.recordPart(id, { until: 'transcribed' });
  assert.equal(env.store.get(id).noteStale, false, 'still no note');

  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready', 'note');
  await env.recordPart(id, { until: 'ready' });
  assert.equal(env.store.get(id).noteStale, true);

  const note = value(await env.api.notes.getLatest(id));
  value(
    await env.api.notes.saveEdit(id, { ...note.note, summary: 'edited by hand' }, note.version),
  );
  assert.equal(env.store.get(id).noteStale, true, 'the edit did not add the new recording');
});

test('a hand-written first note after appending is based on the current transcript', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  await env.recordPart(id, { until: 'transcribed' });
  value(
    await env.api.notes.saveEdit(
      id,
      { summary: 'mine', keyTopics: [], decisions: [], openQuestions: [], actionItems: [] },
      0,
    ),
  );
  assert.equal(env.store.get(id).noteStale, false);
  await env.recordPart(id, { until: 'ready' });
  assert.equal(env.store.get(id).noteStale, true);
});

test('recording can only start in settled states; running work and failed recordings block it', async (t) => {
  const env = await createMainSession(t, {
    sidecar: () => succeedingSidecar(PART, 400, PART_DURATION),
  });
  const id = await env.recordTo('transcribing', { title: 'Busy' });
  // 正在转写
  failure(await env.api.recording.start(id), 'INVALID_STATE');
  await until(() => env.status(id) === 'transcribed', 'transcribed');

  // 正在生成
  env.setMode('timeout', 400);
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'generating', 'generating');
  failure(await env.api.recording.start(id), 'INVALID_STATE');
  await until(() => env.status(id) === 'ready', 'ready');

  // 正在录音时不能再开一段
  const job = value(await env.api.recording.start(id)).activeJobId;
  failure(await env.api.recording.start(id), 'INVALID_STATE');
  // 录音失败后必须先丢弃
  value(await env.api.recording.fail(id, job, 'CAPTURE_FAILED'));
  failure(await env.api.recording.start(id), 'INVALID_STATE');
  value(await env.api.recording.cancel(id, job));
  assert.equal(env.status(id), 'ready');
  assert.equal(value(await env.api.recording.start(id)).status, 'recording');
});

test('discarding a failed extra part restores the meeting exactly: transcript, note and retained audio stay', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  value(await env.api.meetings.setRetainAudio(id, true));
  // 第一段在设置保留之前已被清理；保留从第二段开始生效
  await env.recordPart(id, { until: 'transcribed' });
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready', 'note');
  const retained = env.store.getAudios(id);
  assert.equal(retained.length, 1);
  const segments = env.store.getSegments(id);
  const note = value(await env.api.notes.getLatest(id));

  const job = value(await env.api.recording.start(id)).activeJobId;
  const failedPart = env.store.getAudio(id);
  assert.equal(failedPart.partNo, retained[0].partNo + 1);
  value(
    await env.api.recording.appendChunk(
      id,
      job,
      Int16Array.from({ length: 800 }, () => 100),
    ),
  );
  value(await env.api.recording.fail(id, job, 'WRITE_FAILED'));
  assert.equal(env.store.get(id).status, 'failed');
  value(await env.api.recording.cancel(id, job));

  const meeting = env.store.get(id);
  assert.equal(meeting.status, 'ready');
  assert.equal(meeting.noteStale, false, 'nothing was added');
  assert.deepEqual(env.store.getSegments(id), segments);
  assert.deepEqual(value(await env.api.notes.getLatest(id)), note);
  assert.equal(existsSync(failedPart.filePath), false, 'only the discarded part is deleted');
  assert.deepEqual(
    env.store.getAudios(id).map((a) => a.id),
    retained.map((a) => a.id),
  );
  assert.ok(existsSync(retained[0].filePath));
});

test('discarding an extra part on a transcript-only meeting returns to transcribed, and on a fresh one to created', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  const job = value(await env.api.recording.start(id)).activeJobId;
  value(await env.api.recording.fail(id, job, 'CAPTURE_FAILED'));
  value(await env.api.recording.cancel(id, job));
  assert.equal(env.status(id), 'transcribed');

  const fresh = value(await env.api.meetings.create('Fresh')).id;
  const j2 = value(await env.api.recording.start(fresh)).activeJobId;
  value(await env.api.recording.fail(fresh, j2, 'CAPTURE_FAILED'));
  value(await env.api.recording.cancel(fresh, j2));
  assert.equal(env.status(fresh), 'created');
});

test('retention keeps every part when asked to; turning it off or deleting removes all of them', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = value(await env.api.meetings.create('Retained')).id;
  value(await env.api.meetings.setRetainAudio(id, true));
  await env.recordPart(id, { until: 'transcribed' });
  await env.recordPart(id, { until: 'transcribed' });
  await env.recordPart(id, { until: 'transcribed' });
  const files = env.store.getAudios(id);
  assert.deepEqual(
    files.map((a) => [a.partNo, a.transcribed]),
    [
      [1, true],
      [2, true],
      [3, true],
    ],
  );
  assert.ok(files.every((a) => existsSync(a.filePath)));
  assert.equal(env.store.get(id).hasAudio, true);

  value(await env.api.meetings.setRetainAudio(id, false));
  assert.equal(env.store.get(id).hasAudio, false);
  assert.ok(files.every((a) => !existsSync(a.filePath)));
  assert.equal(env.store.getSegments(id).length, 6);

  // 删除会议：保留着的每一段都删掉
  const other = value(await env.api.meetings.create('To delete')).id;
  value(await env.api.meetings.setRetainAudio(other, true));
  await env.recordPart(other, { until: 'transcribed' });
  await env.recordPart(other, { until: 'transcribed' });
  const doomed = env.store.getAudios(other);
  assert.equal(doomed.length, 2);
  value(await env.api.meetings.delete(other));
  assert.ok(doomed.every((a) => !existsSync(a.filePath)));
  assert.deepEqual(env.managedFiles(), []);
});

test('a failed transcription of the new part keeps the old transcript; retry adds only the new part, once', async (t) => {
  let attempt = 0;
  const env = await createMainSession(t, {
    sidecar: () => (++attempt === 2 ? crashingSidecar() : part()),
  });
  const id = await env.recordTo('transcribed');
  const before = env.store.getSegments(id);

  await env.recordPart(id, { until: 'failed' });
  assert.equal(env.store.get(id).lastError.kind, 'transcribing');
  assert.deepEqual(env.store.getSegments(id), before, 'nothing partial is committed');
  assert.equal(env.store.get(id).hasAudio, true, 'the unsent part is kept for the retry');
  assert.equal(env.store.getPendingAudio(id).length, 1);

  value(await env.api.transcription.start(id));
  await until(() => env.status(id) === 'transcribed', 'retry');
  assert.deepEqual(env.store.getSegments(id), [...before, ...shifted(PART_DURATION)]);
  assert.equal(env.store.getPendingAudio(id).length, 0);
  assert.equal(env.store.getTimelineMs(id), PART_DURATION * 2);
});

test('parts recorded while transcription cannot start are transcribed together, in order, in one job', async (t) => {
  let ready = false;
  const models = {
    isReady: () => ready,
    onReady(listener) {
      models.fire = listener;
      return () => {};
    },
    status: () => ({
      model: 'small',
      state: ready ? 'ready' : 'missing',
      totalBytes: 1,
      downloadedBytes: 0,
      downloadable: true,
      error: null,
    }),
    refresh: () => {},
    cancel: async () => {},
    shutdown: async () => {},
    download() {
      return this.status();
    },
  };
  let spawned = 0;
  const env = await createMainSession(t, {
    models: () => models,
    sidecar: () => {
      spawned++;
      return part();
    },
  });
  const id = await env.recordTo('captured', { title: 'Waiting for the model' });
  // 第二段录在"已保存、等待转写"的会议上：这个状态可以继续录音
  await env.recordPart(id, { until: 'captured' });
  assert.equal(env.store.getPendingAudio(id).length, 2);
  assert.deepEqual(
    env.store.getAudios(id).map((a) => a.partNo),
    [1, 2],
  );
  assert.equal(spawned, 0);
  assert.equal(env.store.getJobs(id).filter((j) => j.kind === 'transcribing').length, 0);

  ready = true;
  models.fire();
  await until(() => env.status(id) === 'transcribed', 'transcribed together');
  assert.deepEqual(env.store.getSegments(id), [...PART, ...shifted(PART_DURATION)]);
  assert.equal(spawned, 2, 'one sidecar run per part');
  const transcribing = env.store.getJobs(id).filter((j) => j.kind === 'transcribing');
  assert.equal(transcribing.length, 1, 'a single job covers both parts');

  // 进度跨两段折算，单调不减，最终到 100
  const percents = env.progress.filter((p) => p.jobId === transcribing[0].id).map((p) => p.percent);
  assert.deepEqual(
    percents,
    [...percents].sort((a, b) => a - b),
  );
  assert.ok(percents.every((n) => n >= 0 && n <= 100));
  assert.equal(percents.at(-1), 100);
});

test('after a crash mid-way through an extra part, restart repairs it, keeps earlier parts, and it can be discarded', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  value(await env.api.meetings.setRetainAudio(id, true));
  await env.recordPart(id, { until: 'transcribed' });
  const keptFile = env.store.getAudios(id)[0].filePath;
  const segments = env.store.getSegments(id);

  const job = value(await env.api.recording.start(id)).activeJobId;
  value(
    await env.api.recording.appendChunk(
      id,
      job,
      Int16Array.from({ length: 3200 }, (_, i) => i - 1600),
    ),
  );
  const interrupted = env.store.getAudio(id);

  const restarted = await env.reopen({ sidecar: part });
  const meeting = restarted.store.get(id);
  assert.equal(meeting.status, 'failed');
  assert.deepEqual([meeting.lastError.kind, meeting.lastError.code], ['recording', 'INTERRUPTED']);
  assert.deepEqual(restarted.store.getSegments(id), segments);
  const wav = readFileSync(interrupted.filePath);
  assert.equal(wav.readUInt32LE(40), 3200 * 2, 'the interrupted part was repaired');
  assert.ok(existsSync(keptFile));

  value(await restarted.api.recording.cancel(id, meeting.lastError.jobId));
  assert.equal(restarted.status(id), 'transcribed');
  assert.equal(existsSync(interrupted.filePath), false);
  assert.ok(existsSync(keptFile));
});

test('transcript order is protected: a batch that would sort before existing segments is rejected', async (t) => {
  const env = await createMainSession(t, { sidecar: part });
  const id = await env.recordTo('transcribed');
  const next = env.store.beginRecording(id, join(env.audioDirectory, 'late.wav'));
  env.store.finishRecording(next.id);
  const job = env.store.beginTranscription(id);
  const asset = env.store.getPendingAudio(id)[0];
  assert.throws(
    () =>
      env.store.completeTranscription(
        job.id,
        [{ startMs: 0, endMs: 10, text: 'too early' }],
        [{ assetId: asset.id, durationMs: 10 }],
      ),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.deepEqual(env.store.getSegments(id), PART);
  assert.equal(env.store.get(id).status, 'transcribing', 'the rejected commit changed nothing');
  assert.equal(env.store.getPendingAudio(id).length, 1);
  assert.equal(env.store.getTimelineMs(id), PART_DURATION);
});

test('legacy databases upgrade: audio becomes part 1, already transcribed; notes are not marked stale', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'turnnote-m5-'));
  mkdirSync(join(directory, 'audio'));
  const path = join(directory, 'old.db');
  const db = new Database(path);
  t.after(() => {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  migrate(db, migrations.slice(0, 4));
  const audio = join(directory, 'audio', 'old.wav');
  writeFileSync(audio, 'old audio');
  const meeting = db.prepare(
    'INSERT INTO meetings(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)',
  );
  meeting.run('done', 'Transcribed', 'ready', '2026-10-01', '2026-10-02');
  meeting.run('waiting', 'Not transcribed', 'captured', '2026-10-03', '2026-10-03');
  db.prepare('INSERT INTO audio_assets VALUES(?,?,?,?)').run('a1', 'done', audio, '2026-10-01');
  db.prepare('INSERT INTO audio_assets VALUES(?,?,?,?)').run(
    'a2',
    'waiting',
    join(directory, 'audio', 'w.wav'),
    '2026-10-03',
  );
  db.prepare('INSERT INTO transcript_segments VALUES(?,?,?,?,?)').run(
    'done',
    0,
    0,
    7_000,
    'old transcript',
  );
  const note = { summary: 'old', keyTopics: [], decisions: [], openQuestions: [], actionItems: [] };
  db.prepare(
    'INSERT INTO note_versions(meeting_id,version,source,content_json,created_at) VALUES(?,?,?,?,?)',
  ).run('done', 1, 'generated', JSON.stringify(note), '2026-10-02');
  db.close();

  const store = new MeetingStore(path, join(directory, 'audio'));
  t.after(() => store.close());
  assert.deepEqual(
    store.getAudios('done').map((a) => [a.partNo, a.transcribed]),
    [[1, true]],
  );
  assert.deepEqual(
    store.getAudios('waiting').map((a) => [a.partNo, a.transcribed]),
    [[1, false]],
    'a meeting without a transcript still has its audio waiting',
  );
  assert.equal(store.getTimelineMs('done'), 7_000, 'approximated by the last segment');
  assert.equal(store.getTimelineMs('waiting'), 0);
  assert.equal(store.get('done').noteStale, false);
  assert.equal(store.list().find((m) => m.id === 'done').noteStale, false);
  assert.equal(store.getLatestNote('done').version, 1);

  // 升级后可以继续录音，且第二段编号为 2
  const job = store.beginRecording('done', join(directory, 'audio', 'new.wav'));
  assert.equal(store.getAudio('done').partNo, 2);
  store.finishRecording(job.id);
  const transcribe = store.beginTranscription('done');
  store.completeTranscription(
    transcribe.id,
    [{ startMs: 7_000, endMs: 8_000, text: 'appended' }],
    [{ assetId: store.getPendingAudio('done')[0].id, durationMs: 1_500 }],
  );
  assert.equal(store.get('done').noteStale, true);
  assert.equal(store.get('done').status, 'ready');
  assert.equal(store.getTimelineMs('done'), 8_500);
});

test('the one-audio-per-meeting limit is gone but part numbers and file ownership stay unique', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'turnnote-parts-'));
  mkdirSync(join(directory, 'audio'));
  const store = new MeetingStore(join(directory, 'turnnote.db'), join(directory, 'audio'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = store.create('Parts').id;
  const first = store.beginRecording(id, join(directory, 'audio', 'a.wav'));
  store.finishRecording(first.id);
  const second = store.beginRecording(id, join(directory, 'audio', 'b.wav'));
  assert.deepEqual(
    store.getAudios(id).map((a) => a.partNo),
    [1, 2],
  );
  assert.throws(
    () => store.beginRecording(id, join(directory, 'audio', 'c.wav')),
    (e) => e.code === 'INVALID_STATE',
    'still recording',
  );
  store.finishRecording(second.id);
  const other = store.create('Other').id;
  assert.throws(
    () => store.beginRecording(other, join(directory, 'audio', 'a.wav')),
    (e) => e.code !== undefined,
    'the same file cannot belong to two meetings',
  );
});
