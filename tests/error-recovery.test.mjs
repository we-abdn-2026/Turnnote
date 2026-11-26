import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MeetingStore,
  createDispatcher,
  describeError,
  errorInfo,
  errorMessages,
  errorRecovery,
  isErrorCode,
  migrate,
  migrations,
  requestChatCompletion,
  TurnnoteError,
} from '../out/tests/runtime.mjs';
import { createMainSession, failure, value } from './support/main-session.mjs';

test('every shared error has safe Chinese copy and an explicit recovery category', () => {
  assert.deepEqual(Object.keys(errorRecovery).sort(), Object.keys(errorMessages).sort());
  for (const [code, message] of Object.entries(errorMessages)) {
    assert.equal(isErrorCode(code), true);
    assert.match(message, /[一-鿿]/, code);
    assert.doesNotMatch(message, /deepseek|openai|sk-|\/Users\//i);
    assert.ok(['retry', 'settings', 'permissions', 'reload', 'none'].includes(errorRecovery[code]));
    assert.equal(describeError({ code, message: 'private/path api-key transcript' }), message);
  }
  for (const code of ['AI_TIMEOUT', 'AI_RATE_LIMITED', 'AI_UNAVAILABLE'])
    assert.equal(errorInfo(code).recovery, 'retry');
  for (const code of [
    'API_KEY_MISSING',
    'AI_UNAUTHORIZED',
    'AI_PROVIDER_NOT_CONFIGURED',
    'AI_PAYMENT_REQUIRED',
    'AI_INVALID_RESPONSE',
  ])
    assert.equal(errorInfo(code).recovery, 'settings');
  assert.equal(errorInfo('PERMISSION_DENIED').recovery, 'permissions');
  for (const code of [undefined, null, {}, '__proto__', 'constructor', 'FUTURE_ERROR']) {
    assert.equal(isErrorCode(code), false);
    assert.equal(errorInfo(code).code, 'INTERNAL');
    assert.equal(
      describeError({ code, message: 'sk-secret /private/path transcript' }),
      errorMessages.INTERNAL,
    );
  }
});

test('IPC turns expected codes and unknown exceptions into fixed messages', async () => {
  for (const code of Object.keys(errorMessages)) {
    const dispatch = createDispatcher({
      meetings: {
        get: async () => {
          throw new TurnnoteError(code);
        },
      },
    });
    assert.deepEqual(await dispatch('meetings:get', ['id']), {
      ok: false,
      error: { code, message: errorMessages[code] },
    });
  }
  const dispatch = createDispatcher({
    meetings: {
      get: async () => {
        throw new Error('sk-secret /private/path transcript');
      },
    },
  });
  assert.deepEqual((await dispatch('meetings:get', ['id'])).error, {
    code: 'INTERNAL',
    message: errorMessages.INTERNAL,
  });
});

test('invalid provider URLs fail before fetch instead of appearing as network outages', async () => {
  let calls = 0;
  for (const baseUrl of [
    '',
    'invalid',
    'file:///private/path',
    'https://user:secret@example.com',
    'https://example.com?key=secret',
  ]) {
    await assert.rejects(
      requestChatCompletion(
        { apiKey: 'sk-secret', model: 'm', messages: [] },
        {
          baseUrl,
          fetch: async () => {
            calls++;
            throw new Error('must not call');
          },
        },
      ),
      (error) =>
        error.code === 'AI_PROVIDER_NOT_CONFIGURED' &&
        !error.retryable &&
        !error.message.includes('secret'),
    );
  }
  assert.equal(calls, 0);
});

test('a missing configured provider does not create a job or send meeting content', async (t) => {
  const f = await createMainSession(t);
  const meeting = f.captured();
  const transcript = [{ startMs: 0, endMs: 1000, text: 'Keep this transcript.' }];
  f.store.completeTranscription(f.store.beginTranscription(meeting.id).id, transcript);
  f.store.updateSettings({ noteProvider: 'no-such-service' });
  const before = f.store.getJobs(meeting.id);
  failure(await f.api.notes.generate(meeting.id), 'AI_PROVIDER_NOT_CONFIGURED');
  assert.deepEqual(f.store.getJobs(meeting.id), before);
  assert.deepEqual(f.store.getSegments(meeting.id), transcript);
  assert.equal(f.fetches.length, 0);
  value(await f.api.settings.update({ noteProvider: 'deepseek' }));
  assert.equal((await f.api.notes.generate(meeting.id)).ok, true);
});

const legacyCodes = {
  DEEPSEEK_UNAUTHORIZED: 'AI_UNAUTHORIZED',
  DEEPSEEK_RATE_LIMITED: 'AI_RATE_LIMITED',
  DEEPSEEK_TIMEOUT: 'AI_TIMEOUT',
  DEEPSEEK_INVALID_RESPONSE: 'AI_INVALID_RESPONSE',
  DEEPSEEK_UNAVAILABLE: 'AI_UNAVAILABLE',
};

function oldDatabase(t) {
  const root = mkdtempSync(join(tmpdir(), 'turnnote-error-migration-'));
  const path = join(root, 'old.db');
  const db = new Database(path);
  migrate(db, migrations.slice(0, 5));
  t.after(() => {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const code of [...Object.keys(legacyCodes), 'FUTURE_ERROR']) {
    db.prepare(
      'INSERT INTO meetings (id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).run(code, 'Preserved title', 'failed', '2026-01-01', '2026-01-01');
    db.prepare('INSERT INTO transcript_segments VALUES(?,?,?,?,?)').run(
      code,
      0,
      0,
      1000,
      'Preserved transcript',
    );
    db.prepare(
      'INSERT INTO processing_jobs (id,meeting_id,kind,status,attempt,error_code,error_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      code,
      code,
      'generating',
      'failed',
      1,
      code,
      'sk-secret /private/path transcript',
      '2026-01-01',
      '2026-01-01',
    );
    db.prepare(
      'INSERT INTO note_versions (meeting_id,version,source,content_json,created_at) VALUES(?,?,?,?,?)',
    ).run(
      code,
      1,
      'user',
      JSON.stringify({
        summary: 'Preserved note',
        keyTopics: [],
        decisions: [],
        openQuestions: [],
        actionItems: [],
      }),
      '2026-01-01',
    );
  }
  return { root, path, db };
}

test('migration rewrites every legacy AI code and preserves content; unknown stored errors stay safe', (t) => {
  const { root, path, db } = oldDatabase(t);
  const store = new MeetingStore(path, root);
  t.after(() => store.close());
  assert.equal(db.pragma('user_version', { simple: true }), 6);
  for (const [old, current] of Object.entries({ ...legacyCodes, FUTURE_ERROR: 'INTERNAL' })) {
    const meeting = store.get(old);
    assert.equal(meeting.status, 'failed');
    assert.equal(meeting.updatedAt, '2026-01-01');
    assert.equal(meeting.lastError.code, current);
    assert.equal(meeting.lastError.message, errorMessages[current]);
    assert.equal(store.getJob(old).errorCode, current);
    assert.equal(store.getJob(old).errorMessage, errorMessages[current]);
    assert.equal(store.getSegments(old)[0].text, 'Preserved transcript');
    assert.equal(store.getLatestNote(old).note.summary, 'Preserved note');
    assert.equal(
      db.prepare('SELECT error_code FROM processing_jobs WHERE id=?').get(old).error_code,
      legacyCodes[old] ?? old,
    );
  }
  migrate(db);
  assert.equal(store.getJobs('DEEPSEEK_TIMEOUT').length, 1);
});

test('a failed code migration rolls back all codes and the schema version', (t) => {
  const { path, db } = oldDatabase(t);
  db.exec(
    "CREATE TRIGGER refuse_error_change BEFORE UPDATE OF error_code ON processing_jobs WHEN OLD.error_code='DEEPSEEK_TIMEOUT' BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
  );
  assert.throws(() => new MeetingStore(path, '.'), /blocked/);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
  for (const code of Object.keys(legacyCodes))
    assert.equal(
      db.prepare('SELECT error_code FROM processing_jobs WHERE id=?').get(code).error_code,
      code,
    );
});
