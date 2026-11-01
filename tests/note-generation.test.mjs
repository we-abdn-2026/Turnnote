import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { startServer } from './support/deepseek-mock-server.mjs';
import {
  createDispatcher,
  createInvokeApi,
  createSessionServices,
  errorMessages,
  MeetingStore,
} from '../out/tests/runtime.mjs';

const API_KEY = 'sk-test-secret-value';
const { segments: SEGMENTS } = JSON.parse(
  readFileSync(new URL('./fixtures/sample-transcript.json', import.meta.url), 'utf8'),
);
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const failure = (result, code) =>
  assert.deepEqual(result, { ok: false, error: { code, message: errorMessages[code] } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('generation did not reach its expected state within 5 seconds');
}

async function fixture(t, { apiKey = () => API_KEY, fetch: fetchOverride } = {}) {
  const server = startServer(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-generation-')));
  const audioDirectory = join(root, 'audio');
  mkdirSync(audioDirectory);
  const databasePath = join(root, 'turnnote.db');
  const store = new MeetingStore(databasePath, audioDirectory);
  const events = [];
  const progress = [];
  let mode = 'normal';
  const fetches = [];
  const services = createSessionServices(store, {
    audioDirectory,
    modelsDirectory: join(root, 'models'),
    sidecar: () => assert.fail('generation must not start the ASR sidecar'),
    permissions: () => ({ microphone: 'unknown', screen: 'unknown' }),
    emitMeeting: (meeting) => events.push(meeting),
    emitProgress: (event) => progress.push(event),
    apiKey,
    deepseek: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      fetch: (url, init) => {
        fetches.push(JSON.parse(init.body));
        if (fetchOverride) return fetchOverride(url, init);
        return fetch(url, { ...init, headers: { ...init.headers, 'X-Mock-Mode': mode } });
      },
    },
  });
  const dispatch = createDispatcher(services.handlers);
  const api = createInvokeApi((channel, ...args) => dispatch(channel, args));
  t.after(async () => {
    await services.shutdown();
    store.close();
    server.close();
    server.closeAllConnections();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    api,
    store,
    server,
    services,
    events,
    progress,
    fetches,
    databasePath,
    setMode: (next) => (mode = next),
    transcribed(title = 'Planning') {
      const path = join(audioDirectory, `${title}.wav`);
      writeFileSync(path, 'audio bytes never sent');
      const meeting = store.createCaptured(title, path);
      const job = store.beginTranscription(meeting.id);
      store.completeTranscription(job.id, SEGMENTS);
      return meeting.id;
    },
    status: (id) => store.get(id).status,
  };
}

test('user-triggered generation sends the saved transcript and keywords and stores a generated version', async (t) => {
  const env = await fixture(t);
  const id = env.transcribed();
  value(await env.api.meetings.setKeywords(id, ['Pricing']));
  const started = value(await env.api.notes.generate(id));
  assert.equal(started.status, 'generating');
  assert.ok(started.activeJobId);
  await until(() => env.status(id) === 'ready');

  const latest = value(await env.api.notes.getLatest(id));
  assert.equal(latest.version, 1);
  assert.equal(latest.source, 'generated');
  assert.ok(latest.note.summary.length > 0);
  assert.equal(env.store.getJob(started.activeJobId).status, 'completed');
  assert.deepEqual(env.store.getSegments(id), SEGMENTS);

  const [{ messages }] = env.server.getRequests();
  const sent = JSON.stringify(messages);
  for (const segment of SEGMENTS) assert.ok(sent.includes(`[${segment.startMs}] ${segment.text}`));
  assert.ok(sent.includes('Focus keywords: [\\"Pricing\\"]'));
  assert.ok(!sent.includes('.wav') && !sent.includes('audio bytes') && !sent.includes(API_KEY));
  assert.equal(env.fetches[0].model, 'deepseek-flash');

  const jobProgress = env.progress.filter((event) => event.jobId === started.activeJobId);
  assert.deepEqual(
    jobProgress.map((event) => event.percent),
    [0, 100],
  );
  assert.ok(jobProgress.every((event) => event.kind === 'generating' && event.meetingId === id));
  assert.deepEqual(
    env.events
      .filter((event) => event.id === id)
      .map((event) => event.status)
      .slice(-2),
    ['generating', 'ready'],
  );
});

test('generation is rejected before any request without a key, transcript or valid state', async (t) => {
  let keyReads = 0;
  const env = await fixture(t, {
    apiKey: () => {
      keyReads += 1;
      return '   ';
    },
  });
  const id = env.transcribed();
  failure(await env.api.notes.generate(id), 'API_KEY_MISSING');
  assert.equal(env.status(id), 'transcribed');
  assert.equal(env.store.getJobs(id).filter((job) => job.kind === 'generating').length, 0);

  const empty = value(await env.api.meetings.create('No transcript'));
  failure(await env.api.notes.generate(empty.id), 'INVALID_STATE');
  failure(await env.api.notes.generate('missing'), 'NOT_FOUND');
  assert.equal(keyReads, 1);
  assert.equal(env.fetches.length, 0);
});

test('provider failures keep transcript and edits; retry and regeneration add new versions', async (t) => {
  const env = await fixture(t);
  const id = env.transcribed();
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready');
  const edited = value(
    await env.api.notes.saveEdit(
      id,
      { ...value(await env.api.notes.getLatest(id)).note, summary: 'User edit' },
      1,
    ),
  );
  assert.equal(edited.version, 2);

  for (const [mode, code] of [
    ['rate-limit', 'DEEPSEEK_RATE_LIMITED'],
    ['invalid-json', 'DEEPSEEK_INVALID_RESPONSE'],
  ]) {
    env.setMode(mode);
    const job = value(await env.api.notes.generate(id)).activeJobId;
    await until(() => env.status(id) === 'failed');
    const meeting = value(await env.api.meetings.get(id));
    assert.deepEqual(meeting.lastError, {
      code,
      message: errorMessages[code],
      kind: 'generating',
      jobId: job,
    });
    const latest = value(await env.api.notes.getLatest(id));
    assert.equal(latest.version, 2);
    assert.equal(latest.note.summary, 'User edit');
    assert.deepEqual(env.store.getSegments(id), SEGMENTS);
  }

  env.setMode('normal');
  value(await env.api.notes.generate(id));
  await until(() => env.status(id) === 'ready');
  const latest = value(await env.api.notes.getLatest(id));
  assert.equal(latest.version, 3);
  assert.equal(latest.source, 'generated');
  const db = new Database(env.databasePath, { readonly: true });
  t.after(() => db.close());
  const versions = db
    .prepare(
      'SELECT version, source, content_json FROM note_versions WHERE meeting_id = ? ORDER BY version',
    )
    .all(id);
  assert.deepEqual(
    versions.map((row) => [row.version, row.source]),
    [
      [1, 'generated'],
      [2, 'user'],
      [3, 'generated'],
    ],
  );
  assert.equal(JSON.parse(versions[1].content_json).summary, 'User edit');
  // 凭证不进入 SQLite
  for (const table of ['note_versions', 'processing_jobs', 'app_settings', 'meetings']) {
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(API_KEY));
  }
});

function gatedFetch() {
  const pending = [];
  return {
    pending,
    fetch: (_url, init) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, signal: init.signal });
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
    reply(content) {
      pending
        .shift()
        .resolve(
          new Response(
            JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
          ),
        );
    },
  };
}
const NOTE = JSON.stringify({
  summary: 'Generated',
  keyTopics: [],
  decisions: [
    { text: 'Ship', timestampMs: 2400 },
    { text: 'Invented', timestampMs: 2401 },
  ],
  openQuestions: [],
  actionItems: [],
});

test('a user edit during generation wins; the late result is rejected as CONFLICT', async (t) => {
  const gate = gatedFetch();
  const env = await fixture(t, { fetch: gate.fetch });
  const id = env.transcribed();
  const job = value(await env.api.notes.generate(id)).activeJobId;
  await until(() => gate.pending.length === 1);
  value(
    await env.api.notes.saveEdit(
      id,
      {
        summary: 'Edited meanwhile',
        keyTopics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      },
      0,
    ),
  );
  gate.reply(NOTE);
  await until(() => env.status(id) === 'failed');
  assert.equal(value(await env.api.meetings.get(id)).lastError.code, 'CONFLICT');
  assert.equal(env.store.getJob(job).errorCode, 'CONFLICT');
  const latest = value(await env.api.notes.getLatest(id));
  assert.deepEqual(
    [latest.version, latest.source, latest.note.summary],
    [1, 'user', 'Edited meanwhile'],
  );
});

test('only timestamps of real segments are stored with decisions', async (t) => {
  const gate = gatedFetch();
  const env = await fixture(t, { fetch: gate.fetch });
  const id = env.transcribed();
  value(await env.api.notes.generate(id));
  await until(() => gate.pending.length === 1);
  gate.reply(NOTE);
  await until(() => env.status(id) === 'ready');
  assert.deepEqual(value(await env.api.notes.getLatest(id)).note.decisions, [
    { text: 'Ship', timestampMs: 2400 },
    { text: 'Invented' },
  ]);
});

test('delete aborts the request; shutdown interrupts and a late reply never commits', async (t) => {
  const gate = gatedFetch();
  const env = await fixture(t, { fetch: gate.fetch });
  const deleted = env.transcribed('Deleted');
  value(await env.api.notes.generate(deleted));
  await until(() => gate.pending.length === 1);
  const request = gate.pending[0];
  value(await env.api.meetings.delete(deleted));
  assert.equal(request.signal.aborted, true);
  failure(await env.api.meetings.get(deleted), 'NOT_FOUND');

  gate.pending.length = 0;
  const id = env.transcribed('Interrupted');
  const job = value(await env.api.notes.generate(id)).activeJobId;
  await until(() => gate.pending.length === 1);
  const inFlight = gate.pending[0];
  await env.services.shutdown();
  assert.equal(inFlight.signal.aborted, true);
  assert.equal(env.store.getJob(job).errorCode, 'INTERRUPTED');
  assert.equal(env.status(id), 'failed');
  assert.equal(env.store.getLatestNote(id), null);
  failure(await env.api.notes.generate(id), 'INTERRUPTED');
});
