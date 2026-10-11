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
import { join, resolve } from 'node:path';
import {
  createDispatcher,
  createInvokeApi,
  createSessionServices,
  MeetingStore,
  resolveSidecarCommand,
  errorMessages,
} from '../out/tests/runtime.mjs';
import { pythonExecutable } from './support/python.mjs';

const SEGMENTS = [{ startMs: 0, endMs: 1000, text: 'Controlled audio' }];
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('Main task did not reach its expected state within 5 seconds');
}
function stub(body, { pong = true } = {}) {
  return {
    command: process.execPath,
    args: [
      '-e',
      `const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
       require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
         const msg = JSON.parse(line);
         if (msg.type === 'ping' && ${pong}) out({ id: msg.id, type: 'pong', status: 'ok' });
         if (msg.type === 'transcribe') { ${body} }
         if (msg.type === 'shutdown') process.exit(0);
       });`,
    ],
  };
}
function success() {
  return stub(`
    for (const segment of ${JSON.stringify(SEGMENTS)}) out({ id: msg.id, type: 'segment', ...segment });
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 1 });
  `);
}
function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-transcription-')));
  const audioDirectory = join(root, 'audio');
  mkdirSync(audioDirectory);
  const databasePath = join(root, 'turnnote.db');
  const store = new MeetingStore(databasePath, audioDirectory);
  const events = [];
  const progress = [];
  const options = {
    audioDirectory,
    modelsDirectory: join(root, 'models'),
    sidecar: () =>
      resolveSidecarCommand({
        isPackaged: false,
        appPath: resolve('.'),
        resourcesPath: root,
        env: { TURNNOTE_ASR_FAKE: '1', TURNNOTE_PYTHON: pythonExecutable() },
      }),
    permissions: () => ({ microphone: 'unknown', screen: 'unknown' }),
    emitMeeting: (meeting) => events.push(meeting),
    emitProgress: (event) => progress.push(event),
    ...overrides,
  };
  const services = createSessionServices(store, options);
  const dispatch = createDispatcher(services.handlers);
  const api = createInvokeApi((channel, ...args) => dispatch(channel, args));
  t.after(async () => {
    await services.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    audioDirectory,
    databasePath,
    store,
    services,
    api,
    events,
    progress,
    captured() {
      const path = join(audioDirectory, 'controlled.wav');
      writeFileSync(path, 'controlled input');
      const id = store.createCaptured('Transcription test', path).id;
      return { id, path };
    },
  };
}
const dead = (pid) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

test('production Main composition: PCM IPC → finalized WAV → real fake worker → persistent timestamp segments', async (t) => {
  const f = fixture(t);
  const id = value(await f.api.meetings.create('Controlled recording')).id;
  const recording = value(await f.api.recording.start(id));
  const samples = new Int16Array([123, -456, 789]);
  value(await f.api.recording.appendChunk(id, recording.activeJobId, samples));
  const captured = value(await f.api.recording.stop(id, recording.activeJobId));
  assert.equal(captured.status, 'captured');
  assert.equal(captured.activeJobId, null);
  await until(() => f.store.get(id).status === 'transcribed');
  assert.equal(captured.status, 'captured');
  const wav = readFileSync(f.store.getAudio(id).filePath);
  assert.equal(wav.readUInt32LE(40), samples.byteLength);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readInt16LE(44), 123);
  assert.equal(wav.readInt16LE(46), -456);
  const segments = value(await f.api.transcription.getSegments(id));
  assert.equal(segments.length, 3);
  assert.ok(segments.every((segment) => segment.endMs > segment.startMs && segment.text));
  assert.deepEqual(
    f.events.filter((meeting) => meeting.id === id).map((meeting) => meeting.status),
    ['created', 'recording', 'captured', 'transcribing', 'transcribed'],
  );
  const [captureJob, asrJob] = f.store.getJobs(id);
  assert.equal(captureJob.status, 'completed');
  assert.equal(asrJob.status, 'completed');
  assert.deepEqual(
    f.progress.map((event) => event.percent),
    [0, 100],
  );
  assert.ok(
    f.progress.every((event) => event.jobId === asrJob.id && event.kind === 'transcribing'),
  );
  assert.ok(!JSON.stringify([...f.events, ...f.progress]).includes(f.root));
  const reopened = new MeetingStore(f.databasePath, f.audioDirectory);
  try {
    assert.deepEqual(reopened.getSegments(id), segments);
    assert.equal(reopened.get(id).status, 'transcribed');
    assert.equal(reopened.getJob(asrJob.id).status, 'completed');
  } finally {
    reopened.close();
  }
});

test('partial segments remain private until done; final database/job/state commit is atomic', async (t) => {
  const f = fixture(t, {
    sidecar: () =>
      stub(`
      out({ id: msg.id, type: 'segment', ...${JSON.stringify(SEGMENTS[0])} });
      out({ id: msg.id, type: 'progress', percent: 50 });
      setTimeout(() => out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 1 }), 100);
    `),
  });
  const { id } = f.captured();
  const started = value(await f.api.transcription.start(id));
  assert.equal(started.status, 'transcribing');
  await until(() => f.progress.length === 1);
  assert.deepEqual(value(await f.api.transcription.getSegments(id)), []);
  assert.equal(f.store.getJob(started.activeJobId).status, 'running');
  await until(() => f.store.get(id).status === 'transcribed');
  assert.deepEqual(f.store.getSegments(id), SEGMENTS);
  assert.equal(f.store.getJob(started.activeJobId).status, 'completed');
});

for (const [name, command, code, timeouts] of [
  ['spawn failure', { command: 'turnnote-nonexistent-sidecar', args: [] }, 'SIDECAR_START_FAILED'],
  ['ping timeout', stub('', { pong: false }), 'SIDECAR_START_FAILED', { pingTimeoutMs: 100 }],
  ['idle timeout', stub(''), 'SIDECAR_TIMEOUT', { idleTimeoutMs: 100 }],
  [
    'crash after segment',
    stub(
      `out({ id: msg.id, type: 'segment', ...${JSON.stringify(SEGMENTS[0])} }); process.stderr.write('private/path transcript'); process.exit(3);`,
    ),
    'SIDECAR_CRASHED',
  ],
  [
    'invalid JSON',
    stub(`process.stdout.write('private/path invalid JSON\\n');`),
    'SIDECAR_PROTOCOL_ERROR',
  ],
  [
    'model error',
    stub(
      `out({ id: msg.id, type: 'error', code: 'MODEL_LOAD_FAILED', message: 'private/path model' });`,
    ),
    'MODEL_LOAD_FAILED',
  ],
]) {
  test(`${name} persists a queryable safe job failure and preserves audio for retry`, async (t) => {
    const f = fixture(t, { sidecar: () => command, ...timeouts });
    const { id, path } = f.captured();
    const started = value(await f.api.transcription.start(id));
    await until(() => f.store.get(id).status === 'failed');
    const meeting = value(await f.api.meetings.get(id));
    assert.deepEqual(meeting.lastError, {
      kind: 'transcribing',
      jobId: started.activeJobId,
      code,
      message: errorMessages[code],
    });
    assert.equal(meeting.hasAudio, true);
    assert.equal(meeting.activeJobId, null);
    assert.ok(existsSync(path));
    assert.deepEqual(f.store.getSegments(id), []);
    const reopened = new MeetingStore(f.databasePath, f.audioDirectory);
    try {
      assert.equal(reopened.getJob(started.activeJobId).errorCode, code);
      assert.equal(reopened.getJob(started.activeJobId).errorMessage, errorMessages[code]);
      assert.deepEqual(reopened.get(id).lastError, meeting.lastError);
    } finally {
      reopened.close();
    }
    assert.ok(!JSON.stringify(meeting).includes('private/path'));
  });
}

test('SQL failure during done rolls back all segments and completion, then persists INTERNAL', async (t) => {
  const f = fixture(t, { sidecar: success });
  const { id, path } = f.captured();
  const db = new Database(f.databasePath);
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_second_step BEFORE UPDATE OF status ON processing_jobs
    WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'private/path injected'); END;`);
  const started = value(await f.api.transcription.start(id));
  await until(() => f.store.get(id).status === 'failed');
  assert.equal(f.store.getJob(started.activeJobId).errorCode, 'INTERNAL');
  assert.deepEqual(f.store.getSegments(id), []);
  assert.ok(existsSync(path));
  assert.equal(
    f.events.some((event) => event.status === 'transcribed'),
    false,
  );
  db.exec('DROP TRIGGER fail_second_step');
  const retry = value(await f.api.transcription.start(id));
  await until(() => f.store.get(id).status === 'transcribed');
  assert.notEqual(retry.activeJobId, started.activeJobId);
  assert.equal(f.store.getJob(retry.activeJobId).attempt, 2);
  assert.deepEqual(f.store.getSegments(id), SEGMENTS);
});

test('missing, directory or escaped managed audio fails before spawning and is queryable', async (t) => {
  for (const kind of [
    'missing',
    'directory',
    ...(process.platform === 'win32' ? [] : ['symlink', 'parent']),
  ]) {
    await t.test(kind, async (t) => {
      let spawns = 0;
      const f = fixture(t, {
        sidecar: () => {
          spawns++;
          return success();
        },
      });
      const { id, path } = f.captured();
      rmSync(path);
      if (kind === 'directory') mkdirSync(path);
      if (kind === 'symlink') {
        const outside = join(f.root, 'outside.wav');
        writeFileSync(outside, 'outside audio');
        symlinkSync(outside, path);
      }
      if (kind === 'parent') {
        const outside = join(f.root, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'controlled.wav'), 'outside audio');
        rmSync(f.audioDirectory, { recursive: true });
        symlinkSync(outside, f.audioDirectory);
      }
      value(await f.api.transcription.start(id));
      await until(() => f.store.get(id).status === 'failed');
      assert.equal(f.store.get(id).lastError.code, 'AUDIO_NOT_FOUND');
      assert.deepEqual(f.store.getSegments(id), []);
      assert.equal(spawns, 0);
    });
  }
});

test('cancel releases the real process; immediate retry and stale cancel cannot affect the new job', async (t) => {
  let pidPath;
  let attempts = 0;
  const f = fixture(t, {
    sidecar: () =>
      ++attempts === 1
        ? stub(`
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    out({ id: msg.id, type: 'segment', ...${JSON.stringify(SEGMENTS[0])} });
    out({ id: msg.id, type: 'progress', percent: 10 });
  `)
        : success(),
  });
  pidPath = join(f.root, 'pid');
  const { id, path } = f.captured();
  const first = value(await f.api.transcription.start(id));
  await until(() => f.progress.length === 1);
  const pid = Number(readFileSync(pidPath, 'utf8'));
  const cancel = f.api.transcription.cancel(id, first.activeJobId);
  const retry = value(await f.api.transcription.start(id));
  assert.equal(value(await cancel).status, 'captured');
  dead(pid);
  assert.notEqual(retry.activeJobId, first.activeJobId);
  assert.equal(
    (await f.api.transcription.cancel(id, first.activeJobId)).error.code,
    'INVALID_STATE',
  );
  await until(() => f.store.get(id).status === 'transcribed');
  assert.equal(f.store.getJob(first.activeJobId).status, 'cancelled');
  assert.equal(f.store.getJob(retry.activeJobId).status, 'completed');
  assert.deepEqual(f.store.getSegments(id), SEGMENTS);
  assert.ok(existsSync(path));
});

test('deletion invalidates job, kills process before removing audio and prevents late completion', async (t) => {
  let pidPath;
  const f = fixture(t, {
    sidecar: () =>
      stub(`
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    out({ id: msg.id, type: 'progress', percent: 10 });
    setTimeout(() => {
      out({ id: msg.id, type: 'segment', ...${JSON.stringify(SEGMENTS[0])} });
      out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 1 });
    }, 200);
  `),
  });
  pidPath = join(f.root, 'pid');
  const { id, path } = f.captured();
  value(await f.api.transcription.start(id));
  await until(() => f.progress.length === 1);
  const pid = Number(readFileSync(pidPath, 'utf8'));
  value(await f.api.meetings.delete(id));
  dead(pid);
  assert.equal(existsSync(path), false);
  assert.equal((await f.api.meetings.get(id)).error.code, 'NOT_FOUND');
  await delay(250);
  assert.deepEqual(
    f.events.map((event) => event.status),
    ['transcribing', 'deleted'],
  );
});

test('shutdown kills active sidecars, persists interruption and prevents new starts', async (t) => {
  let pidPath;
  const f = fixture(t, {
    sidecar: () =>
      stub(`
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    out({ id: msg.id, type: 'progress', percent: 10 });
  `),
  });
  pidPath = join(f.root, 'pid');
  const { id, path } = f.captured();
  const job = value(await f.api.transcription.start(id)).activeJobId;
  await until(() => f.progress.length === 1);
  const pid = Number(readFileSync(pidPath, 'utf8'));
  await f.services.shutdown();
  dead(pid);
  assert.equal(f.store.getJob(job).errorCode, 'INTERRUPTED');
  assert.equal(f.store.get(id).lastError.code, 'INTERRUPTED');
  assert.ok(existsSync(path));
  assert.equal((await f.api.transcription.start(id)).error.code, 'INTERRUPTED');
  assert.equal((await f.api.recording.start(id)).error.code, 'INTERRUPTED');
});

test('shutdown still releases every process if interruption cannot be written to SQLite', async (t) => {
  let root;
  const f = fixture(t, {
    sidecar: () =>
      stub(`
      require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(root)}, msg.id), String(process.pid));
      out({ id: msg.id, type: 'progress', percent: 10 });
    `),
  });
  root = f.root;
  const { id } = f.captured();
  const otherPath = join(f.audioDirectory, 'second.wav');
  writeFileSync(otherPath, 'controlled audio');
  const otherId = f.store.createCaptured('Second transcription', otherPath).id;
  const jobs = [
    value(await f.api.transcription.start(id)).activeJobId,
    value(await f.api.transcription.start(otherId)).activeJobId,
  ];
  await until(() => f.progress.length === 2);
  const pids = jobs.map((jobId) => Number(readFileSync(join(root, jobId), 'utf8')));
  const db = new Database(f.databasePath);
  try {
    db.exec(`CREATE TRIGGER block_failure BEFORE UPDATE OF status ON processing_jobs
      WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;`);
    await f.services.shutdown();
    pids.forEach(dead);
    assert.ok(jobs.every((jobId) => f.store.getJob(jobId).status === 'running'));
    assert.deepEqual(f.store.getSegments(id), []);
    db.exec('DROP TRIGGER block_failure');
    f.store.interruptProcessing();
    assert.ok(jobs.every((jobId) => f.store.getJob(jobId).errorCode === 'INTERRUPTED'));
  } finally {
    db.close();
  }
});

test('captured listener manual start/cancel invalidates scheduled automatic transcription', async (t) => {
  let f;
  let manualStart;
  let cancel;
  f = fixture(t, {
    emitMeeting: (meeting) => {
      if (meeting.status === 'captured' && !manualStart) {
        manualStart = f.api.transcription.start(meeting.id);
        cancel = f.api.transcription.cancel(meeting.id, f.store.get(meeting.id).activeJobId);
      }
    },
  });
  const id = value(await f.api.meetings.create('Recording')).id;
  const jobId = value(await f.api.recording.start(id)).activeJobId;
  value(await f.api.recording.appendChunk(id, jobId, new Int16Array([1])));
  assert.equal(value(await f.api.recording.stop(id, jobId)).status, 'captured');
  value(await manualStart);
  value(await cancel);
  await delay(50);
  assert.equal(f.store.get(id).status, 'captured');
  assert.deepEqual(f.store.getSegments(id), []);
  assert.equal(f.store.getJobs(id).filter((job) => job.kind === 'transcribing').length, 1);
  assert.deepEqual(f.progress, []);
});

test('immediate manual start/cancel after stop cannot be restarted by the scheduled task', async (t) => {
  const f = fixture(t);
  const id = value(await f.api.meetings.create('Recording')).id;
  const jobId = value(await f.api.recording.start(id)).activeJobId;
  value(await f.api.recording.appendChunk(id, jobId, new Int16Array([1])));
  value(await f.api.recording.stop(id, jobId));
  const job = value(await f.api.transcription.start(id)).activeJobId;
  value(await f.api.transcription.cancel(id, job));
  await delay(50);
  assert.equal(f.store.get(id).status, 'captured');
  assert.equal(f.store.getJobs(id).filter((job) => job.kind === 'transcribing').length, 1);
});

test('deleting or quitting immediately after capture cancels automatic launch', async (t) => {
  for (const action of ['delete', 'shutdown']) {
    await t.test(action, async (t) => {
      let calls = 0;
      const f = fixture(t, {
        sidecar: () => {
          calls++;
          return success();
        },
      });
      const id = value(await f.api.meetings.create('Recording')).id;
      const jobId = value(await f.api.recording.start(id)).activeJobId;
      value(await f.api.recording.appendChunk(id, jobId, new Int16Array([1])));
      value(await f.api.recording.stop(id, jobId));
      if (action === 'delete') value(await f.api.meetings.delete(id));
      else await f.services.shutdown();
      await delay(50);
      assert.equal(calls, 0);
      if (action === 'shutdown') assert.equal(f.store.get(id).status, 'captured');
    });
  }
});

test('event listeners throwing or mutating payloads cannot corrupt the committed state', async (t) => {
  const f = fixture(t, {
    sidecar: success,
    emitMeeting: (meeting) => {
      meeting.status = 'deleted';
      meeting.title = 'Mutated';
      throw new Error('private/path observer failure');
    },
    emitProgress: () => {
      throw new Error('private/path observer failure');
    },
  });
  const { id } = f.captured();
  value(await f.api.transcription.start(id));
  await until(() => f.store.get(id).status === 'transcribed');
  assert.equal(f.store.get(id).title, 'Transcription test');
  assert.deepEqual(f.store.getSegments(id), SEGMENTS);
  value(await f.api.meetings.delete(id));
  assert.equal((await f.api.meetings.get(id)).error.code, 'NOT_FOUND');
});

test('command resolution uses explicit dev/packaged paths and fake flag on macOS, Windows and Linux', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-command-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const platform of ['darwin', 'win32', 'linux']) {
    const options = { appPath: root, resourcesPath: join(root, 'resources'), platform, env: {} };
    const command = resolveSidecarCommand({ ...options, isPackaged: true });
    assert.equal(
      command.command,
      join(
        options.resourcesPath,
        'asr-worker',
        platform === 'win32' ? 'asr-worker.exe' : 'asr-worker',
      ),
    );
    assert.deepEqual(command.args, []);
    const python = platform === 'win32' ? 'python' : 'python3';
    assert.deepEqual(resolveSidecarCommand({ ...options, isPackaged: false }), {
      command: python,
      args: [join(root, 'services', 'asr-worker', 'worker.py')],
    });
    const venv =
      platform === 'win32'
        ? join(root, '.venv', 'Scripts', 'python.exe')
        : join(root, '.venv', 'bin', 'python');
    mkdirSync(join(venv, '..'), { recursive: true });
    writeFileSync(venv, '');
    assert.equal(resolveSidecarCommand({ ...options, isPackaged: false }).command, venv);
    assert.deepEqual(
      resolveSidecarCommand({
        ...options,
        isPackaged: false,
        env: { TURNNOTE_ASR_FAKE: '1', TURNNOTE_PYTHON: 'custom-python' },
      }),
      {
        command: 'custom-python',
        args: [join(root, 'services', 'asr-worker', 'worker.py'), '--fake'],
      },
    );
    rmSync(join(root, '.venv'), { recursive: true });
  }
});
