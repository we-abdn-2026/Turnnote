/**
 * #36 / #37 共用的真实 Main 会话 fixture。
 * 一次装配：MeetingStore + createSessionServices + sidecar + AI provider mock。
 * 不启动 Electron；录音/导入/导出的对话框全部可注入。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './deepseek-mock-server.mjs';
import { pythonExecutable } from './python.mjs';
import {
  createDispatcher,
  createInvokeApi,
  createSessionServices,
  errorMessages,
  MeetingStore,
  resolveSidecarCommand,
} from '../../out/tests/runtime.mjs';

export const API_KEY = 'sk-test-secret-value';
export const SAMPLE_WAV = fileURLToPath(new URL('../fixtures/sample-en.wav', import.meta.url));
export const SAMPLE_SEGMENTS = JSON.parse(
  readFileSync(new URL('../fixtures/sample-transcript.json', import.meta.url), 'utf8'),
).segments;

export const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
export const failure = (result, code) =>
  assert.deepEqual(result, { ok: false, error: { code, message: errorMessages[code] } });
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(condition, label = 'condition', timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(15);
  }
  assert.fail(`${label} not reached within ${timeoutMs}ms`);
}

/** Node 子进程 stub sidecar；body 在收到 transcribe 时执行 */
export function stubSidecar(body, { pong = true } = {}) {
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

export const succeedingSidecar = (segments = SAMPLE_SEGMENTS, pauseMs = 0) =>
  stubSidecar(`
    setTimeout(() => {
      for (const segment of ${JSON.stringify(segments)}) out({ id: msg.id, type: 'segment', ...segment });
      out({
        id: msg.id,
        type: 'done',
        detectedLanguage: 'en',
        durationMs: ${segments.at(-1)?.endMs ?? 1000},
        segmentCount: ${segments.length},
      });
    }, ${pauseMs});
  `);

export const crashingSidecar = () => stubSidecar('process.exit(1);');
export const hangingSidecar = (pauseMs = 60_000) =>
  stubSidecar(`
    out({ id: msg.id, type: 'progress', percent: 1 });
    setTimeout(() => {}, ${pauseMs});
  `);

function realFakeWorker(root) {
  return () =>
    resolveSidecarCommand({
      isPackaged: false,
      appPath: resolve('.'),
      resourcesPath: root,
      env: { TURNNOTE_ASR_FAKE: '1', TURNNOTE_PYTHON: pythonExecutable() },
    });
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{
 *   sidecar?: () => { command: string, args?: string[] },
 *   useRealFakeWorker?: boolean,
 *   apiKeys?: Record<string, string | null>,
 *   providerTimeoutMs?: number,
 *   permissions?: () => { microphone: string, screen: string },
 *   root?: string,
 *   recover?: boolean,
 *   shared?: object,
 * }} [opts]
 */
export async function createMainSession(t, opts = {}) {
  const shared = opts.shared ?? {
    server: null,
    mode: 'normal',
    timeoutMsHeader: undefined,
    keys: new Map(
      Object.entries(opts.apiKeys ?? { deepseek: API_KEY }).filter(
        ([, v]) => v != null && v !== '',
      ),
    ),
    fetches: [],
    events: [],
    progress: [],
    ownedRoot: !opts.root,
  };

  if (!shared.server) {
    shared.server = startServer(0);
    await once(shared.server, 'listening');
    t.after(() => {
      shared.server.close();
      shared.server.closeAllConnections();
    });
  }

  const root = opts.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-main-')));
  const audioDirectory = join(root, 'audio');
  const downloads = join(root, 'downloads');
  const exportsDir = join(root, 'exports');
  mkdirSync(audioDirectory, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  mkdirSync(exportsDir, { recursive: true });
  const databasePath = join(root, 'turnnote.db');
  const store = new MeetingStore(databasePath, audioDirectory);
  if (opts.recover) store.interruptProcessing();

  const credentials = {
    has: (provider) =>
      shared.keys.has(provider) && Boolean(String(shared.keys.get(provider)).trim()),
    get: (provider) => {
      const k = shared.keys.get(provider);
      return k == null ? null : String(k).trim() || null;
    },
    set: (provider, k) => shared.keys.set(provider, k),
    clear: (provider) => shared.keys.delete(provider),
  };

  let chooseFile = async () => null;
  let chooseSavePath = async (name) => join(exportsDir, name);
  const sidecar =
    opts.sidecar ?? (opts.useRealFakeWorker ? realFakeWorker(root) : () => succeedingSidecar());

  const services = createSessionServices(store, {
    audioDirectory,
    modelsDirectory: join(root, 'models'),
    sidecar,
    permissions: opts.permissions ?? (() => ({ microphone: 'granted', screen: 'granted' })),
    emitMeeting: (meeting) => shared.events.push(structuredClone(meeting)),
    emitProgress: (event) => shared.progress.push(structuredClone(event)),
    credentials,
    provider: {
      baseUrl: `http://127.0.0.1:${shared.server.address().port}/v1`,
      timeoutMs: opts.providerTimeoutMs,
      fetch: (url, init) => {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
        shared.fetches.push({ url: String(url), body, headers: { ...init.headers } });
        const headers = {
          ...init.headers,
          'X-Mock-Mode': shared.mode,
          ...(shared.timeoutMsHeader != null
            ? { 'X-Mock-Timeout-Ms': String(shared.timeoutMsHeader) }
            : {}),
        };
        return fetch(url, { ...init, headers });
      },
    },
    importAudio: { chooseFile: (...args) => chooseFile(...args) },
    exports: { chooseSavePath: (...args) => chooseSavePath(...args), timeZone: 'UTC' },
  });

  if (opts.recover) {
    await services.recover();
    for (const meeting of store.getDeleted()) {
      await services.handlers.meetings.delete(meeting.id);
    }
  }

  const dispatch = createDispatcher(services.handlers);
  const api = createInvokeApi((channel, ...args) => dispatch(channel, args));
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await services.shutdown().catch(() => {});
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  t.after(async () => {
    await close();
    if (shared.ownedRoot && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    audioDirectory,
    downloads,
    exportsDir,
    databasePath,
    store,
    services,
    api,
    events: shared.events,
    progress: shared.progress,
    fetches: shared.fetches,
    credentials,
    server: shared.server,
    close,
    setMode: (next, timeoutMs) => {
      shared.mode = next;
      shared.timeoutMsHeader = timeoutMs;
    },
    setChooseFile: (fn) => {
      chooseFile = fn;
    },
    setChooseSavePath: (fn) => {
      chooseSavePath = fn;
    },
    setKey: (provider, key) => {
      if (key == null) shared.keys.delete(provider);
      else shared.keys.set(provider, key);
    },
    status: (id) => store.get(id).status,
    managedFiles: () => readdirSync(audioDirectory),
    pickImport(name, source = SAMPLE_WAV) {
      const path = join(downloads, name);
      if (typeof source === 'string' && existsSync(source)) copyFileSync(source, path);
      else if (Buffer.isBuffer(source) || typeof source === 'string') writeFileSync(path, source);
      else copyFileSync(source, path);
      chooseFile = async () => path;
      return path;
    },
    async recordTo(status = 'transcribed', { title = 'Pipeline meeting', samples } = {}) {
      const meeting = value(await api.meetings.create(title));
      const started = value(await api.recording.start(meeting.id));
      const pcm = samples ?? Int16Array.from({ length: 1600 }, (_, i) => ((i * 13) % 2000) - 1000);
      value(await api.recording.appendChunk(meeting.id, started.activeJobId, pcm));
      value(await api.recording.stop(meeting.id, started.activeJobId));
      await until(() => store.get(meeting.id).status === status, `recording→${status}`);
      return meeting.id;
    },
    captured(title = 'Captured', content = 'audio bytes') {
      const path = join(audioDirectory, `${title.replace(/\W+/g, '_')}-${Date.now()}.wav`);
      if (typeof content === 'string' && existsSync(content)) copyFileSync(content, path);
      else writeFileSync(path, content);
      return store.createCaptured(title, path);
    },
    /**
     * 模拟进程重启：关闭当前 session，在同一 root/db 上新建 session 并跑 recover。
     * 返回新 session；旧 session 不再可用。
     */
    async reopen(extra = {}) {
      await close();
      shared.ownedRoot = false; // 根目录由新 session 的 after 负责（或测试显式保留）
      const next = await createMainSession(t, {
        ...opts,
        ...extra,
        root,
        recover: true,
        shared: { ...shared, ownedRoot: true },
      });
      return next;
    },
  };
}
