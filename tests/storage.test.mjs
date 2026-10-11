import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStorageHandlers,
  MeetingStore,
  migrate,
  migrations,
  createDispatcher,
} from '../out/tests/runtime.mjs';

const SEGMENTS = [
  { startMs: 0, endMs: 2400, text: '预算讨论 Budget review' },
  { startMs: 2400, endMs: 5000, text: 'Alex will prepare release notes.' },
];
const NOTE = {
  summary: 'Launch review',
  keyTopics: ['Launch'],
  decisions: [{ text: 'Ship Friday', timestampMs: 2400 }],
  openQuestions: [],
  actionItems: [
    { task: 'Prepare notes', owner: 'Alex', dueDate: 'unspecified', timestampMs: 2400 },
  ],
};
const errorCode = (code) => (error) => error.code === code;
const resources = new WeakMap();
function using(t, resource) {
  const list = resources.get(t);
  if (list) list.push(resource);
  else t.after(() => resource.close());
  return resource;
}

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-storage-')));
  const audioDirectory = join(directory, 'audio');
  mkdirSync(audioDirectory);
  const databasePath = join(directory, 'turnnote.db');
  const store = new MeetingStore(databasePath, audioDirectory);
  const list = [store];
  resources.set(t, list);
  t.after(() => {
    for (const resource of list.toReversed()) resource.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    directory,
    databasePath,
    audioDirectory,
    audioPath: join(audioDirectory, 'recording.wav'),
    close() {
      store.close();
      list.splice(list.indexOf(store), 1);
    },
  };
}
function transcribed(store, audioPath) {
  const meeting = store.createCaptured('Planning', audioPath);
  const job = store.beginTranscription(meeting.id);
  assert.equal(store.completeTranscription(job.id, SEGMENTS), true);
  return meeting.id;
}
function ready(store, audioPath) {
  const id = transcribed(store, audioPath);
  const job = store.beginGeneration(id);
  store.completeGeneration(job.id, NOTE);
  return id;
}

test('new database has six tables, migration version, foreign keys and lifecycle indexes', (t) => {
  const { store, databasePath, audioPath } = fixture(t);
  const db = using(t, new Database(databasePath));
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name),
    [
      'app_settings',
      'audio_assets',
      'meetings',
      'note_versions',
      'processing_jobs',
      'transcript_segments',
    ],
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const meeting = store.create('  Weekly review  ');
  assert.equal(meeting.title, 'Weekly review');
  assert.equal(meeting.status, 'created');
  assert.equal(meeting.hasAudio, false);
  assert.equal(meeting.lastError, null);
  assert.throws(() => store.create('  '), errorCode('INVALID_INPUT'));
  assert.throws(() => store.create('a'.repeat(201)), errorCode('INVALID_INPUT'));
  assert.throws(() => store.get('absent'), errorCode('NOT_FOUND'));
  const job = store.beginRecording(meeting.id, audioPath);
  assert.equal(job.kind, 'recording');
  assert.throws(() => store.beginRecording(meeting.id, '/outside.wav'), errorCode('INVALID_STATE'));
});

test('version 1 upgrades without losing meetings, audio, transcripts, note versions, jobs or settings', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'turnnote-upgrade-'));
  const path = join(directory, 'old.db');
  const db = new Database(path);
  let store;
  t.after(() => {
    store?.close();
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  migrate(db, migrations.slice(0, 1));
  db.prepare('INSERT INTO meetings(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(
    'old-meeting',
    'Old meeting',
    'ready',
    '2026-10-01',
    '2026-10-01',
  );
  db.prepare('INSERT INTO audio_assets VALUES(?,?,?,?)').run(
    'old-audio',
    'old-meeting',
    join(directory, 'audio', 'old.wav'),
    '2026-10-01',
  );
  db.prepare('INSERT INTO transcript_segments VALUES(?,?,?,?,?)').run(
    'old-meeting',
    0,
    0,
    1000,
    'Original transcript',
  );
  db.prepare('INSERT INTO note_versions VALUES(?,?,?,?,?)').run(
    'old-meeting',
    1,
    'generated',
    JSON.stringify(NOTE),
    '2026-10-01',
  );
  db.prepare('INSERT INTO processing_jobs VALUES(?,?,?,?,?,?,?,?,?)').run(
    'old-job',
    'old-meeting',
    'generating',
    'completed',
    1,
    null,
    null,
    '2026-10-01',
    '2026-10-01',
  );
  db.prepare('INSERT INTO app_settings VALUES(?,?)').run(
    'transcriptionLanguage',
    JSON.stringify('zh'),
  );
  db.close();
  store = new MeetingStore(path, join(directory, 'audio'));
  assert.equal(store.get('old-meeting').status, 'ready');
  assert.equal(store.getAudio('old-meeting').id, 'old-audio');
  assert.equal(store.getSegments('old-meeting')[0].text, 'Original transcript');
  assert.deepEqual(store.getLatestNote('old-meeting').note, NOTE);
  assert.equal(store.getJob('old-job').status, 'completed');
  assert.equal(store.getSettings().transcriptionLanguage, 'zh');
});

test('failed multi-step migration rolls back schema, data and user_version; future versions are rejected', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrate(db, migrations.slice(0, 1));
  db.prepare('INSERT INTO meetings(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(
    'existing',
    'Existing',
    'created',
    'now',
    'now',
  );
  assert.throws(() =>
    migrate(db, [
      ...migrations,
      { version: 3, sql: 'CREATE TABLE should_rollback(value TEXT); INVALID SQL;' },
    ]),
  );
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'should_rollback'").get()
      .count,
    0,
  );
  assert.equal(
    db.prepare('SELECT title FROM meetings WHERE id = ?').get('existing').title,
    'Existing',
  );
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO processing_jobs VALUES('recording','existing','recording','running',1,NULL,NULL,'now','now')",
      )
      .run(),
  );
  migrate(db);
  db.pragma('user_version = 99');
  assert.throws(() => migrate(db), /newer/);
  assert.equal(db.pragma('user_version', { simple: true }), 99);
  assert.throws(() => migrate(db, [{ version: 2, sql: '' }]), /sequence/);
});

test('meeting metadata, transcript search and settings are persistent and do not interpret SQL or wildcard input', (t) => {
  const f = fixture(t);
  const id = ready(f.store, f.audioPath);
  f.store.rename(id, "Plan ' ; DROP TABLE meetings; --");
  f.store.setKeywords(id, ['Pricing', '预算', 'Pricing']);
  f.store.setRetainAudio(id, true);
  const edited = { ...NOTE, summary: 'User reviewed summary' };
  f.store.saveEdit(id, edited, 1);
  f.store.updateSettings({
    transcriptionLanguage: 'zh',
    includeSystemAudio: false,
    microphoneDeviceId: 'device-1',
  });
  assert.equal(f.store.list('预算')[0].id, id);
  assert.equal(f.store.list('BUDGET')[0].id, id);
  assert.equal(f.store.list('%').length, 0);
  assert.equal(f.store.list("' ; DROP").length, 1);
  const latest = f.store.getLatestNote(id);
  latest.note.summary = 'External mutation';
  assert.equal(f.store.getLatestNote(id).note.summary, edited.summary);
  f.close();
  const reopened = using(t, new MeetingStore(f.databasePath, f.audioDirectory));
  assert.deepEqual(reopened.get(id).keywords, ['Pricing', '预算']);
  assert.equal(reopened.get(id).retainAudio, true);
  assert.deepEqual(reopened.getSegments(id), SEGMENTS);
  assert.deepEqual(reopened.getLatestNote(id).note, edited);
  assert.equal(reopened.getLatestNote(id).version, 2);
  assert.equal(reopened.getJobs(id).length, 2);
  assert.equal(reopened.getAudio(id).filePath, f.audioPath);
  assert.equal(reopened.getSettings().transcriptionLanguage, 'zh');
});

test('recording failure preserves audio, cancellation resets state and stop commits captured without pretending ASR exists', (t) => {
  const { store, audioPath } = fixture(t);
  const meeting = store.create('Recording');
  assert.throws(() => store.beginTranscription(meeting.id), errorCode('INVALID_STATE'));
  assert.throws(() => store.beginGeneration(meeting.id), errorCode('INVALID_STATE'));
  const failed = store.beginRecording(meeting.id, audioPath);
  store.failJob(failed.id, 'CAPTURE_FAILED');
  assert.equal(store.get(meeting.id).lastError.kind, 'recording');
  assert.equal(store.get(meeting.id).hasAudio, true);
  assert.throws(() => store.beginTranscription(meeting.id), errorCode('INVALID_STATE'));
  assert.throws(() => store.beginRecording(meeting.id, audioPath), errorCode('INVALID_STATE'));
  store.cancelRecording(meeting.id, failed.id);
  assert.equal(store.get(meeting.id).status, 'created');
  assert.equal(store.get(meeting.id).hasAudio, false);
  const recording = store.beginRecording(meeting.id, audioPath);
  assert.equal(recording.attempt, 2);
  store.finishRecording(recording.id);
  assert.equal(store.get(meeting.id).status, 'captured');
  assert.equal(store.finishRecording(recording.id), false);
  assert.equal(store.failJob(recording.id, 'WRITE_FAILED'), false);
});

test('managed audio path validation and job creation roll back together', (t) => {
  const { store, audioDirectory, directory } = fixture(t);
  const id = store.create('Capture').id;
  for (const path of [
    'relative.wav',
    join(directory, 'outside.wav'),
    audioDirectory,
    join(audioDirectory, '..', 'outside.wav'),
  ]) {
    assert.throws(() => store.beginRecording(id, path), errorCode('INVALID_INPUT'));
    assert.equal(store.get(id).status, 'created');
    assert.deepEqual(store.getJobs(id), []);
  }
  assert.throws(
    () => store.createCaptured('Imported', join(directory, 'outside.wav')),
    errorCode('INVALID_INPUT'),
  );
  assert.equal(store.list().length, 1);
});

test('audio file ownership is unique across meetings and duplicate attachment rolls back', (t) => {
  const { store, audioPath } = fixture(t);
  const first = store.createCaptured('First owner', audioPath);
  const second = store.create('Second owner');
  assert.throws(() => store.beginRecording(second.id, audioPath), /UNIQUE/);
  assert.equal(store.get(first.id).hasAudio, true);
  assert.equal(store.get(second.id).status, 'created');
  assert.deepEqual(store.getJobs(second.id), []);
});

for (const existing of [false, true]) {
  test(`internal directory aliases cannot share audio ownership (${existing ? 'existing' : 'future'} file)`, async (t) => {
    const { store, audioDirectory } = fixture(t);
    const realDirectory = join(audioDirectory, 'real');
    const aliasDirectory = join(audioDirectory, 'alias');
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, aliasDirectory, 'junction');
    const realPath = join(realDirectory, 'shared.wav');
    const aliasPath = join(aliasDirectory, 'shared.wav');
    if (existing) writeFileSync(realPath, 'shared audio');
    const owner = store.createCaptured('Alias owner', aliasPath);
    assert.equal(store.getAudio(owner.id).filePath, realPath);
    const recording = store.create('Duplicate recording');
    assert.throws(() => store.createCaptured('Duplicate import', realPath), /UNIQUE/);
    assert.throws(() => store.beginRecording(recording.id, realPath), /UNIQUE/);
    assert.equal(store.list().length, 2);
    assert.equal(store.get(recording.id).status, 'created');
    assert.equal(store.get(recording.id).hasAudio, false);
    assert.deepEqual(store.getJobs(recording.id), []);
    // 创建尚不存在的录音文件后，正式 handler 仍能清理登记的规范路径。
    if (!existing) writeFileSync(realPath, 'shared audio');
    const handlers = createStorageHandlers(store, audioDirectory, () => {});
    assert.deepEqual(await handlers.meetings.delete(owner.id), { ok: true, value: null });
    assert.equal(existsSync(realPath), false);
  });
}

test('cancel/retry invalidates old job results and progress identity, and retries only the failed stage', (t) => {
  const { store, audioPath } = fixture(t);
  const id = store.createCaptured('Retry', audioPath).id;
  const old = store.beginTranscription(id);
  store.cancelTranscription(id, old.id);
  const current = store.beginTranscription(id);
  assert.notEqual(current.id, old.id);
  assert.equal(current.attempt, 2);
  assert.throws(() => store.cancelTranscription(id, old.id), errorCode('INVALID_STATE'));
  assert.equal(store.get(id).activeJobId, current.id);
  assert.equal(store.completeTranscription(old.id, SEGMENTS), false);
  assert.equal(store.failJob(old.id, 'TRANSCRIBE_FAILED'), false);
  assert.deepEqual(store.getSegments(id), []);
  assert.equal(store.get(id).status, 'transcribing');
  store.failJob(current.id, 'TRANSCRIBE_FAILED');
  assert.equal(store.get(id).hasAudio, true);
  assert.throws(() => store.beginGeneration(id), errorCode('INVALID_STATE'));
  const retry = store.beginTranscription(id);
  store.completeTranscription(retry.id, SEGMENTS);
  const generation = store.beginGeneration(id);
  store.failJob(generation.id, 'DEEPSEEK_TIMEOUT');
  assert.throws(() => store.beginTranscription(id), errorCode('INVALID_STATE'));
  assert.deepEqual(store.getSegments(id), SEGMENTS);
  assert.equal(store.beginGeneration(id).attempt, 2);
});

test('transcription commits segments, completed job and meeting status atomically, including SQL failures', (t) => {
  const { store, audioPath, databasePath } = fixture(t);
  const id = store.createCaptured('Atomic transcript', audioPath).id;
  const job = store.beginTranscription(id);
  const db = using(t, new Database(databasePath));
  db.exec(
    "CREATE TRIGGER reject_second_segment BEFORE INSERT ON transcript_segments WHEN NEW.sequence = 1 BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  assert.throws(() => store.completeTranscription(job.id, SEGMENTS), /injected failure/);
  assert.deepEqual(store.getSegments(id), []);
  assert.equal(store.getJob(job.id).status, 'running');
  assert.equal(store.get(id).status, 'transcribing');
  db.exec('DROP TRIGGER reject_second_segment');
  assert.throws(
    () => store.completeTranscription(job.id, [{ startMs: 10, endMs: 1, text: 'invalid' }]),
    errorCode('INVALID_INPUT'),
  );
  store.completeTranscription(job.id, SEGMENTS);
  assert.equal(store.getJob(job.id).status, 'completed');
  assert.equal(store.get(id).status, 'transcribed');
});

test('note generation rollback, failure and retry preserve all previous user versions', (t) => {
  const { store, audioPath, databasePath } = fixture(t);
  const id = ready(store, audioPath);
  store.saveEdit(id, { ...NOTE, summary: 'Reviewed' }, 1);
  const job = store.beginGeneration(id);
  const db = using(t, new Database(databasePath));
  db.exec(
    "CREATE TRIGGER reject_note BEFORE INSERT ON note_versions BEGIN SELECT RAISE(ABORT,'note failure'); END;",
  );
  assert.throws(() => store.completeGeneration(job.id, NOTE), /note failure/);
  assert.equal(store.getLatestNote(id).version, 2);
  assert.equal(store.getJob(job.id).status, 'running');
  assert.equal(store.get(id).status, 'generating');
  db.exec('DROP TRIGGER reject_note');
  store.failJob(job.id, 'DEEPSEEK_INVALID_RESPONSE');
  assert.equal(store.get(id).lastError.code, 'DEEPSEEK_INVALID_RESPONSE');
  assert.equal(store.getLatestNote(id).note.summary, 'Reviewed');
  const retry = store.beginGeneration(id);
  store.completeGeneration(retry.id, NOTE);
  assert.equal(store.getLatestNote(id).version, 3);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM note_versions WHERE meeting_id = ?').get(id).n,
    3,
  );
});

test('optimistic edits reject stale writers and in-flight generation cannot supersede newer user edits', (t) => {
  const { store, audioPath, databasePath, audioDirectory } = fixture(t);
  const id = ready(store, audioPath);
  const other = using(t, new MeetingStore(databasePath, audioDirectory));
  store.saveEdit(id, { ...NOTE, summary: 'First editor' }, 1);
  assert.throws(
    () => other.saveEdit(id, { ...NOTE, summary: 'Stale editor' }, 1),
    errorCode('CONFLICT'),
  );
  const job = store.beginGeneration(id);
  other.saveEdit(id, { ...NOTE, summary: 'Edited during generation' }, 2);
  assert.throws(() => store.completeGeneration(job.id, NOTE), errorCode('CONFLICT'));
  store.failJob(job.id, 'CONFLICT');
  assert.equal(store.getLatestNote(id).note.summary, 'Edited during generation');
  assert.equal(store.getLatestNote(id).version, 3);
  assert.equal(store.get(id).lastError.code, 'CONFLICT');
});

test('settings accept only non-sensitive known fields and failed patches cannot partially persist', (t) => {
  const { store, databasePath } = fixture(t);
  const before = store.getSettings();
  for (const patch of [
    { apiKey: 'secret' },
    { transcriptionLanguage: 'fr' },
    { transcriptionModel: '../outside' },
    { includeSystemAudio: undefined },
    { includeSystemAudio: false, apiKey: 'secret' },
  ]) {
    assert.throws(() => store.updateSettings(patch), errorCode('INVALID_INPUT'));
    assert.deepEqual(store.getSettings(), before);
  }
  const db = using(t, new Database(databasePath));
  assert.throws(
    () =>
      db.prepare('INSERT INTO app_settings VALUES(?,?)').run('apiKey', JSON.stringify('secret')),
    /CHECK/,
  );
  assert.equal(readFileSync(databasePath).includes(Buffer.from('secret')), false);
});

test('startup interruption is idempotent and preserves audio, transcripts and user notes', (t) => {
  const { store, audioPath, audioDirectory } = fixture(t);
  const transcriptionId = store.createCaptured('Interrupted transcription', audioPath).id;
  const transcription = store.beginTranscription(transcriptionId);
  const generationId = ready(store, join(audioDirectory, 'another.wav'));
  store.saveEdit(generationId, { ...NOTE, summary: 'Saved edit' }, 1);
  const generation = store.beginGeneration(generationId);
  const recordingId = store.create('Unrepaired recording').id;
  store.beginRecording(recordingId, join(audioDirectory, 'partial.wav'));
  store.interruptProcessing();
  store.interruptProcessing();
  assert.equal(store.getJob(transcription.id).errorCode, 'INTERRUPTED');
  assert.equal(store.getJob(generation.id).errorCode, 'INTERRUPTED');
  assert.equal(store.get(transcriptionId).hasAudio, true);
  assert.deepEqual(store.getSegments(generationId), SEGMENTS);
  assert.equal(store.getLatestNote(generationId).note.summary, 'Saved edit');
  assert.equal(store.get(recordingId).status, 'recording');
  assert.equal(store.completeGeneration(generation.id, NOTE), false);
});

test('deletion tombstone invalidates active results and cascade removal deletes every dependent row', async (t) => {
  const { store, audioPath, audioDirectory, databasePath } = fixture(t);
  const id = ready(store, audioPath);
  writeFileSync(audioPath, 'managed audio');
  const job = store.beginGeneration(id);
  const events = [];
  const handlers = createStorageHandlers(store, audioDirectory, (meeting) => events.push(meeting));
  assert.deepEqual(await handlers.meetings.delete(id), { ok: true, value: null });
  assert.equal(existsSync(audioPath), false);
  assert.equal(store.completeGeneration(job.id, NOTE), false);
  assert.equal(events.at(-1).status, 'deleted');
  assert.throws(() => store.get(id), errorCode('NOT_FOUND'));
  const db = using(t, new Database(databasePath));
  for (const table of ['audio_assets', 'transcript_segments', 'note_versions', 'processing_jobs'])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE meeting_id = ?`).get(id).n, 0);
});

test('failed file deletion keeps tombstone for retry, hides the meeting and does not fake successful cleanup', async (t) => {
  const { store, audioPath, audioDirectory } = fixture(t);
  mkdirSync(audioPath);
  const id = store.createCaptured('Deletion retry', audioPath).id;
  const handlers = createStorageHandlers(store, audioDirectory, () => {});
  assert.equal((await handlers.meetings.delete(id)).error.code, 'WRITE_FAILED');
  assert.equal(store.list().length, 0);
  assert.equal(store.getDeleted()[0].id, id);
  assert.equal(store.getAudio(id).filePath, audioPath);
  rmSync(audioPath, { recursive: true });
  assert.deepEqual(await handlers.meetings.delete(id), { ok: true, value: null });
  assert.deepEqual(store.getDeleted(), []);
});

test('attachment rejects symlink ancestors outside the managed root and file symlinks', (t) => {
  const { store, audioDirectory, directory } = fixture(t);
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  const outsidePath = join(outside, 'keep.wav');
  writeFileSync(outsidePath, 'keep');
  symlinkSync(outside, join(audioDirectory, 'link'), 'junction');
  assert.throws(
    () => store.createCaptured('Unsafe parent', join(audioDirectory, 'link', 'keep.wav')),
    errorCode('INVALID_INPUT'),
  );
  const localPath = join(audioDirectory, 'keep.wav');
  writeFileSync(localPath, 'local');
  for (const [name, target] of [
    ['external.wav', outsidePath],
    ['alias.wav', localPath],
  ]) {
    const alias = join(audioDirectory, name);
    symlinkSync(target, alias, 'file');
    assert.throws(() => store.createCaptured('Unsafe file', alias), errorCode('INVALID_INPUT'));
  }
  assert.deepEqual(store.list(), []);
  assert.equal(readFileSync(outsidePath, 'utf8'), 'keep');
  assert.equal(readFileSync(localPath, 'utf8'), 'local');
});

test('deletion rejects ancestors replaced by symlinks outside the managed root without deleting external files', async (t) => {
  const { store, audioDirectory, directory } = fixture(t);
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  const outsidePath = join(outside, 'keep.wav');
  writeFileSync(outsidePath, 'keep');
  const parent = join(audioDirectory, 'link');
  mkdirSync(parent);
  const id = store.createCaptured('Unsafe parent', join(parent, 'keep.wav')).id;
  rmSync(parent, { recursive: true });
  symlinkSync(outside, parent, 'junction');
  const result = await createStorageHandlers(store, audioDirectory, () => {}).meetings.delete(id);
  assert.equal(result.error.code, 'WRITE_FAILED');
  assert.equal(readFileSync(outsidePath, 'utf8'), 'keep');
});

test('audio retention guards reference cleanup and Main exposes real storage methods while unavailable services stay explicit', async (t) => {
  const { store, audioPath, audioDirectory } = fixture(t);
  const id = transcribed(store, audioPath);
  const audio = store.getAudio(id);
  store.setRetainAudio(id, true);
  assert.throws(() => store.removeAudioReference(id, audio.id), errorCode('INVALID_STATE'));
  store.setRetainAudio(id, false);
  store.removeAudioReference(id, audio.id);
  assert.equal(store.get(id).hasAudio, false);
  const dispatch = createDispatcher(createStorageHandlers(store, audioDirectory, () => {}));
  assert.equal((await dispatch('meetings:get', [id])).value.id, id);
  assert.deepEqual((await dispatch('transcription:get-segments', [id])).value, SEGMENTS);
  assert.equal((await dispatch('notes:generate', [id])).error.code, 'NOT_IMPLEMENTED');
  assert.equal((await dispatch('recording:start', [id])).error.code, 'NOT_IMPLEMENTED');
  assert.equal((await dispatch('settings:set-api-key', ['secret'])).error.code, 'NOT_IMPLEMENTED');
});
