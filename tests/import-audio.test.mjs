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
  createImportHandlers,
  createInvokeApi,
  createSessionServices,
  IMPORT_EXTENSIONS,
  MeetingStore,
} from '../out/tests/runtime.mjs';

const SEGMENTS = [{ startMs: 0, endMs: 1000, text: 'Imported audio' }];
const ORIGINAL = Buffer.from('user original bytes that must never change');
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const failure = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail('state not reached within 5 seconds');
}
function stub(body) {
  return {
    command: process.execPath,
    args: [
      '-e',
      `const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
       require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
         const msg = JSON.parse(line);
         if (msg.type === 'ping') out({ id: msg.id, type: 'pong', status: 'ok' });
         if (msg.type === 'transcribe') { ${body} }
         if (msg.type === 'shutdown') process.exit(0);
       });`,
    ],
  };
}
const succeeds = (pause = 0) =>
  stub(`
    setTimeout(() => {
      for (const segment of ${JSON.stringify(SEGMENTS)}) out({ id: msg.id, type: 'segment', ...segment });
      out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 1 });
    }, ${pause});
  `);
const undecodable = () =>
  stub(
    `out({ id: msg.id, type: 'error', code: 'AUDIO_DECODE_FAILED', message: 'Audio file could not be decoded.' });`,
  );

function fixture(t, { sidecar = () => assert.fail('sidecar must not start') } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-import-')));
  const audioDirectory = join(root, 'audio');
  const downloads = join(root, 'downloads');
  mkdirSync(audioDirectory);
  mkdirSync(downloads);
  const store = new MeetingStore(join(root, 'turnnote.db'), audioDirectory);
  const events = [];
  const chosen = { next: null, calls: 0 };
  const services = createSessionServices(store, {
    audioDirectory,
    modelsDirectory: join(root, 'models'),
    sidecar: () => sidecar(),
    permissions: () => ({ microphone: 'unknown', screen: 'unknown' }),
    emitMeeting: (meeting) => events.push(meeting),
    emitProgress: () => {},
    importAudio: {
      chooseFile: async () => {
        chosen.calls += 1;
        return chosen.next;
      },
    },
  });
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
    downloads,
    store,
    services,
    api,
    events,
    chosen,
    /** 在「下载」目录放一个用户文件并让选择器返回它 */
    pick(name, content = ORIGINAL) {
      const path = join(downloads, name);
      writeFileSync(path, content);
      chosen.next = path;
      return path;
    },
    managed: () => readdirSync(audioDirectory),
  };
}

test('cancelling the file chooser returns null and leaves no meeting or file behind', async (t) => {
  const f = fixture(t);
  f.chosen.next = null;
  assert.equal(value(await f.api.meetings.importAudio()), null);
  assert.equal(f.chosen.calls, 1);
  assert.deepEqual(f.managed(), []);
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual(f.events, []);
});

test('import copies into the managed directory, captures, auto-transcribes, then cleans only the copy', async (t) => {
  const f = fixture(t, { sidecar: () => succeeds() });
  const source = f.pick('周会 录音.MP3');
  const meeting = value(await f.api.meetings.importAudio());
  assert.equal(meeting.status, 'captured');
  assert.equal(meeting.title, '周会 录音');
  assert.equal(meeting.hasAudio, true);
  assert.equal(meeting.retainAudio, false);

  const copy = f.store.getAudio(meeting.id).filePath;
  assert.match(copy, /[0-9a-f-]{36}\.mp3$/);
  assert.equal(realpathSync(join(copy, '..')), realpathSync(f.audioDirectory));
  assert.deepEqual(readFileSync(copy), ORIGINAL);

  await until(() => f.store.get(meeting.id).status === 'transcribed');
  assert.deepEqual(f.store.getSegments(meeting.id), SEGMENTS);
  assert.equal(f.store.get(meeting.id).hasAudio, false);
  assert.deepEqual(f.managed(), []);
  assert.deepEqual(readFileSync(source), ORIGINAL);
  assert.deepEqual(
    f.events.filter((m) => m.id === meeting.id).map((m) => m.status),
    ['captured', 'transcribing', 'transcribed'],
  );
});

test('an imported meeting marked retain keeps its copy after transcription', async (t) => {
  const f = fixture(t, { sidecar: () => succeeds(150) });
  const source = f.pick('keep.wav');
  const meeting = value(await f.api.meetings.importAudio());
  f.store.setRetainAudio(meeting.id, true);
  await until(() => f.store.get(meeting.id).status === 'transcribed');
  assert.equal(f.store.get(meeting.id).hasAudio, true);
  assert.equal(f.managed().length, 1);
  assert.deepEqual(readFileSync(source), ORIGINAL);
});

test('unsupported, empty, missing, directory and relative sources are rejected without side effects', async (t) => {
  const f = fixture(t);
  for (const name of ['notes.txt', 'voice.flac', 'noextension', 'archive.wav.zip']) {
    const path = f.pick(name);
    failure(await f.api.meetings.importAudio(), 'AUDIO_DECODE_FAILED');
    assert.deepEqual(readFileSync(path), ORIGINAL, name);
  }
  f.pick('empty.wav', Buffer.alloc(0));
  failure(await f.api.meetings.importAudio(), 'AUDIO_DECODE_FAILED');

  f.chosen.next = join(f.downloads, 'missing.wav');
  failure(await f.api.meetings.importAudio(), 'AUDIO_NOT_FOUND');
  mkdirSync(join(f.downloads, 'folder.wav'));
  f.chosen.next = join(f.downloads, 'folder.wav');
  failure(await f.api.meetings.importAudio(), 'AUDIO_NOT_FOUND');
  f.chosen.next = 'relative.wav';
  failure(await f.api.meetings.importAudio(), 'AUDIO_NOT_FOUND');

  assert.deepEqual(f.managed(), []);
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual(f.events, []);
});

test('every extension the sidecar accepts is accepted, case-insensitively, and stored lowercase', async (t) => {
  const f = fixture(t, { sidecar: () => succeeds(300) });
  for (const extension of IMPORT_EXTENSIONS) {
    f.pick(`clip${extension.toUpperCase()}`);
    const meeting = value(await f.api.meetings.importAudio());
    assert.ok(f.store.getAudio(meeting.id).filePath.endsWith(extension));
  }
});

test('the importable extensions stay in sync with the sidecar', () => {
  const worker = readFileSync(new URL('../services/asr-worker/worker.py', import.meta.url), 'utf8');
  const declared = worker.match(/^AUDIO_EXTENSIONS = \{([^}]*)\}/m)[1];
  const sidecar = [...declared.matchAll(/"(\.[a-z0-9]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...IMPORT_EXTENSIONS].sort(), sidecar);
});

test('oversized files are refused before anything is copied', async (t) => {
  const f = fixture(t);
  const handlers = createImportHandlers(f.store, {
    audioDirectory: f.audioDirectory,
    chooseFile: async () => f.pick('big.wav', Buffer.alloc(11)),
    emit: () => assert.fail('no event'),
    schedule: () => assert.fail('no transcription'),
    maxBytes: 10,
  });
  await assert.rejects(handlers.importAudio(), (error) => error.code === 'INVALID_INPUT');
  assert.deepEqual(f.managed(), []);
});

test('a copy failure is WRITE_FAILED and a database failure after the copy removes the copy', async (t) => {
  const f = fixture(t);
  const source = f.pick('disk.wav');
  const options = {
    chooseFile: async () => source,
    emit: () => assert.fail('no event'),
    schedule: () => assert.fail('no transcription'),
  };
  const noDisk = createImportHandlers(f.store, {
    ...options,
    audioDirectory: join(f.root, 'missing-audio-directory'),
  });
  await assert.rejects(noDisk.importAudio(), (error) => error.code === 'WRITE_FAILED');

  const broken = Object.create(f.store);
  broken.createCaptured = () => {
    throw new Error('injected database failure');
  };
  const handlers = createImportHandlers(broken, { ...options, audioDirectory: f.audioDirectory });
  await assert.rejects(handlers.importAudio(), /injected database failure/);
  assert.deepEqual(f.managed(), []);
  assert.deepEqual(readFileSync(source), ORIGINAL);
});

test('an undecodable file fails with AUDIO_DECODE_FAILED, keeps the copy for retry, and the retry cleans up', async (t) => {
  let attempt = 0;
  const f = fixture(t, { sidecar: () => (++attempt === 1 ? undecodable() : succeeds()) });
  f.pick('broken.m4a');
  const meeting = value(await f.api.meetings.importAudio());
  await until(() => f.store.get(meeting.id).status === 'failed');
  const failed = f.store.get(meeting.id);
  assert.equal(failed.lastError.code, 'AUDIO_DECODE_FAILED');
  assert.equal(failed.hasAudio, true);
  assert.equal(f.managed().length, 1);

  value(await f.api.transcription.start(meeting.id));
  await until(() => f.store.get(meeting.id).status === 'transcribed');
  assert.deepEqual(f.managed(), []);
});

test('deleting an imported meeting removes the managed copy and never the original', async (t) => {
  const f = fixture(t, { sidecar: () => undecodable() });
  const source = f.pick('delete-me.wav');
  const meeting = value(await f.api.meetings.importAudio());
  await until(() => f.store.get(meeting.id).status === 'failed');
  assert.equal(f.managed().length, 1);
  value(await f.api.meetings.delete(meeting.id));
  assert.deepEqual(f.managed(), []);
  assert.ok(existsSync(source));
  assert.deepEqual(readFileSync(source), ORIGINAL);
});

test('titles come from the file name: whitespace collapsed, long names truncated', async (t) => {
  const f = fixture(t, { sidecar: () => succeeds(300) });
  f.pick(`  a   b\t c .wav`);
  assert.equal(value(await f.api.meetings.importAudio()).title, 'a b c');
  f.pick(`${'x'.repeat(240)}.wav`);
  assert.equal(value(await f.api.meetings.importAudio()).title, 'x'.repeat(200));
});

test('IPC validation applies, and without a chooser the method stays NOT_IMPLEMENTED', async (t) => {
  const f = fixture(t);
  const dispatch = createDispatcher(f.services.handlers);
  failure(await dispatch('meetings:import-audio', ['/etc/passwd']), 'INVALID_INPUT');
  assert.equal(f.chosen.calls, 0);

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-import-bare-')));
  mkdirSync(join(root, 'audio'));
  const store = new MeetingStore(join(root, 'turnnote.db'), join(root, 'audio'));
  const bare = createSessionServices(store, {
    audioDirectory: join(root, 'audio'),
    modelsDirectory: join(root, 'models'),
    sidecar: () => assert.fail('sidecar must not start'),
    permissions: () => ({ microphone: 'unknown', screen: 'unknown' }),
    emitMeeting: () => {},
    emitProgress: () => {},
  });
  t.after(async () => {
    await bare.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  failure(await createDispatcher(bare.handlers)('meetings:import-audio', []), 'NOT_IMPLEMENTED');
});
