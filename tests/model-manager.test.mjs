import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL_SOURCES,
  MODEL_MANIFEST,
  SIDECAR_MODEL_FILES,
  createDispatcher,
  createModelHandlers,
  createModelManager,
  modelSizeBytes,
} from '../out/tests/runtime.mjs';
import { deadSource, fakeModel, startModelServer } from './support/model-server.mjs';

const MODEL = 'fake';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, label = 'condition', timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail(`${label} not reached within ${timeoutMs}ms`);
}

function setup(t, { manifestEntry, sources, model = MODEL, ...overrides }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-model-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsDirectory = join(root, 'models');
  const statuses = [];
  const manager = createModelManager({
    modelsDirectory,
    getModelName: () => model,
    emit: (status) => statuses.push(structuredClone(status)),
    manifest: { [model]: manifestEntry },
    sources,
    retryDelayMs: 5,
    probeTimeoutMs: 400,
    stallTimeoutMs: 400,
    ...overrides,
  });
  t.after(() => manager.shutdown());
  return {
    root,
    modelsDirectory,
    finalDir: join(modelsDirectory, model),
    partialRoot: join(modelsDirectory, '.partial'),
    statuses,
    manager,
    ready: () => until(() => manager.status().state === 'ready', 'ready'),
    failed: () => until(() => manager.status().state === 'failed', 'failed'),
  };
}
const code = (c) => (error) => error.code === c;

test('downloads, verifies and installs atomically; sidecar never sees a partial directory', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const server = await startModelServer(t, files);
  const env = setup(t, { manifestEntry, sources: [server.url] });
  const seenWhileDownloading = [];
  let readyCalls = 0;
  env.manager.onReady(() => readyCalls++);

  assert.equal(env.manager.status().state, 'missing');
  assert.equal(env.manager.status().downloadable, true);
  assert.equal(env.manager.status().totalBytes, modelSizeBytes(manifestEntry));
  env.manager.ensure();
  seenWhileDownloading.push(env.manager.status().state, existsSync(env.finalDir));
  await env.ready();

  assert.deepEqual(seenWhileDownloading, ['downloading', false]);
  for (const [name, content] of files) {
    assert.deepEqual(readFileSync(join(env.finalDir, name)), content, name);
  }
  assert.equal(existsSync(env.partialRoot), false, 'no .partial left behind');
  assert.equal(readyCalls, 1);
  assert.equal(env.manager.isReady(), true);

  // 事件序列：downloading… → ready；下载中从未出现最终目录；进度单调且不越界
  const states = env.statuses.map((status) => status.state);
  assert.equal(states[0], 'downloading');
  assert.equal(states.at(-1), 'ready');
  const progress = env.statuses
    .filter((status) => status.state === 'downloading')
    .map((status) => status.downloadedBytes);
  assert.deepEqual(
    progress,
    [...progress].sort((a, b) => a - b),
  );
  assert.ok(progress.every((n) => n >= 0 && n <= modelSizeBytes(manifestEntry)));
});

test('an installed model is left alone: no requests, no re-download', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const server = await startModelServer(t, files);
  const env = setup(t, { manifestEntry, sources: [server.url] });
  env.manager.ensure();
  await env.ready();
  const before = server.hits.length;
  env.manager.ensure();
  assert.equal(env.manager.download().state, 'ready');
  await delay(30);
  assert.equal(server.hits.length, before);
});

test('mirror failover: a dead source, a failing source and a 404 source all fall through to a working one', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const good = await startModelServer(t, files);
  const broken = await startModelServer(t, files, { status: 503 });
  const missing = await startModelServer(t, new Map()); // 所有文件 404
  const dead = await deadSource();
  const env = setup(t, { manifestEntry, sources: [dead, broken.url, missing.url, good.url] });
  env.manager.ensure();
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
  // 404 属于客户端错误：不在同一源上白白重试
  assert.equal(missing.gets('config.json').length <= 1, true);
});

test('the fastest responding source is tried first', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const slow = await startModelServer(t, files, { headDelayMs: 300 });
  const fast = await startModelServer(t, files);
  const env = setup(t, { manifestEntry, sources: [slow.url, fast.url], probeTimeoutMs: 1_000 });
  env.manager.ensure();
  await env.ready();
  assert.equal(fast.gets().length > 0, true);
  assert.equal(slow.gets().length, 0, 'configured-first but slower source is not used');
});

test('tampered content is discarded and fetched from the next source; the bad file is not kept', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const tampered = await startModelServer(t, files, { corrupt: new Set(['model.bin']) });
  const good = await startModelServer(t, files, { headDelayMs: 100 });
  const env = setup(t, { manifestEntry, sources: [tampered.url, good.url], probeTimeoutMs: 1_000 });
  env.manager.ensure();
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
  assert.equal(
    tampered.gets('model.bin').length,
    1,
    'integrity failures do not retry the same source',
  );
});

test('every source tampered → failed with a stable code, nothing installed, bad bytes removed', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const a = await startModelServer(t, files, { corrupt: new Set(['model.bin']) });
  const b = await startModelServer(t, files, { corrupt: new Set(['model.bin']) });
  const logged = [];
  const env = setup(t, {
    manifestEntry,
    sources: [a.url, b.url],
    logger: { error: (...args) => logged.push(args.slice(0, 3)) },
  });
  env.manager.ensure();
  await env.failed();
  const status = env.manager.status();
  assert.equal(status.error.code, 'MODEL_DOWNLOAD_FAILED');
  assert.equal(JSON.stringify(status).includes('127.0.0.1'), false, 'no URL in the status');
  assert.equal(existsSync(env.finalDir), false);
  const partialModel = join(env.partialRoot, `${MODEL}@${manifestEntry.revision}`, 'model.bin');
  assert.equal(existsSync(partialModel), false);
  assert.deepEqual(logged, [['main', 'model_download_failed', 'MODEL_DOWNLOAD_FAILED']]);
});

test('a connection cut mid-file resumes with a Range request instead of starting over', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 200_000 });
  const server = await startModelServer(t, files, {
    cutOnce: { name: 'model.bin', after: 60_000 },
  });
  const env = setup(t, { manifestEntry, sources: [server.url] });
  env.manager.ensure();
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
  const weights = server.gets('model.bin');
  assert.equal(weights.length, 2);
  assert.equal(weights[0].range, null);
  assert.match(weights[1].range, /^bytes=\d+-$/);
  const offset = Number(/bytes=(\d+)-/.exec(weights[1].range)[1]);
  assert.ok(offset > 0 && offset < files.get('model.bin').length);
});

test('a partial download from a previous run is resumed by a new manager', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 100_000 });
  const server = await startModelServer(t, files);
  const env = setup(t, { manifestEntry, sources: [server.url] });
  const partial = join(env.partialRoot, `${MODEL}@${manifestEntry.revision}`);
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, 'model.bin'), files.get('model.bin').subarray(0, 40_000));
  writeFileSync(join(partial, 'config.json'), files.get('config.json')); // 已完整的文件被跳过
  assert.equal(env.manager.status().state, 'missing');
  env.manager.ensure();
  assert.ok(env.manager.status().downloadedBytes >= 40_000 + files.get('config.json').length);
  await env.ready();
  assert.equal(server.gets('config.json').length, 0, 'verified files are not fetched again');
  assert.equal(server.gets('model.bin')[0].range, 'bytes=40000-');
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
});

test('a server that ignores Range restarts the file and still verifies it', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 50_000 });
  const server = await startModelServer(t, files, { ignoreRange: true });
  const env = setup(t, { manifestEntry, sources: [server.url] });
  const partial = join(env.partialRoot, `${MODEL}@${manifestEntry.revision}`);
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, 'model.bin'), files.get('model.bin').subarray(0, 20_000));
  env.manager.ensure();
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
});

test('a stalled connection is abandoned and the next source finishes the job', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 50_000 });
  const stalling = await startModelServer(t, files, { stall: 'model.bin' });
  const good = await startModelServer(t, files, { headDelayMs: 150 });
  const env = setup(t, {
    manifestEntry,
    sources: [stalling.url, good.url],
    stallTimeoutMs: 120,
    attemptsPerSource: 2,
    probeTimeoutMs: 1_000,
  });
  env.manager.ensure();
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
});

test('cancel keeps the downloaded part, reports missing (not failed), and a later download resumes', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 400_000 });
  // 响应延迟让取消发生在 model.bin 的传输过程中
  const server = await startModelServer(t, files, { bodyDelayMs: 40 });
  const env = setup(t, { manifestEntry, sources: [server.url] });
  env.manager.ensure();
  await until(() => server.gets('model.bin').length > 0, 'model.bin requested');
  await env.manager.cancel();
  const status = env.manager.status();
  assert.equal(status.state, 'missing');
  assert.equal(status.error, null);
  assert.equal(existsSync(env.finalDir), false);
  assert.equal(existsSync(join(env.partialRoot, `${MODEL}@${manifestEntry.revision}`)), true);

  env.manager.download();
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
  assert.equal(server.gets('config.json').length, 1, 'completed files survive a cancel');
});

test('not enough disk space fails before any download, with its own error code', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const server = await startModelServer(t, files);
  const env = setup(t, {
    manifestEntry,
    sources: [server.url],
    statfs: async () => ({ bavail: 10, bsize: 1_024 }),
  });
  env.manager.ensure();
  await env.failed();
  assert.equal(env.manager.status().error.code, 'INSUFFICIENT_DISK_SPACE');
  assert.equal(server.hits.length, 0);
  assert.equal(existsSync(env.finalDir), false);
});

test('a failed download is not retried automatically; a user retry succeeds once the source recovers', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 20_000 });
  const behavior = { status: 503 }; // 服务暂时不可用
  const server = await startModelServer(t, files, behavior);
  const env = setup(t, { manifestEntry, sources: [server.url], attemptsPerSource: 1 });
  env.manager.ensure();
  await env.failed();
  assert.equal(env.manager.status().error.code, 'MODEL_DOWNLOAD_FAILED');
  assert.equal(env.manager.status().downloadable, true);

  // 同一次会话内 ensure 不会反复重试，避免在离线时无限循环
  const requests = server.hits.length;
  env.manager.ensure();
  await delay(30);
  assert.equal(env.manager.status().state, 'failed');
  assert.equal(server.hits.length, requests);

  delete behavior.status; // 服务恢复
  assert.equal(env.manager.download().state, 'downloading');
  assert.equal(env.manager.status().error, null);
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
});

test('ensure and download do nothing when the sidecar does not need a model', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const server = await startModelServer(t, files);
  const env = setup(t, { manifestEntry, sources: [server.url], required: false });
  assert.equal(env.manager.status().state, 'ready');
  assert.equal(env.manager.status().downloadable, false);
  env.manager.ensure();
  assert.equal(env.manager.download().state, 'ready');
  await delay(30);
  assert.equal(server.hits.length, 0);
});

test('a model outside the manifest can be used if the user placed it, but cannot be downloaded', async (t) => {
  const { manifestEntry } = fakeModel();
  const env = setup(t, { manifestEntry, sources: [], model: 'custom', manifest: {} });
  const { manager } = env;
  assert.deepEqual(
    [manager.status().state, manager.status().downloadable, manager.status().totalBytes],
    ['missing', false, 0],
  );
  assert.throws(() => manager.download(), code('MODEL_NOT_READY'));
  manager.ensure(); // 不会尝试下载
  assert.equal(manager.status().state, 'missing');

  const dir = join(env.modelsDirectory, 'custom');
  mkdirSync(dir, { recursive: true });
  for (const name of SIDECAR_MODEL_FILES) writeFileSync(join(dir, name), 'x');
  assert.equal(manager.status().state, 'ready');
  // 缺 tokenizer.json 时 faster-whisper 会联网，必须判为未就绪
  rmSync(join(dir, 'tokenizer.json'));
  assert.equal(manager.status().state, 'missing');
});

test('a truncated model.bin is not ready; download replaces the incomplete directory', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 30_000 });
  const server = await startModelServer(t, files);
  const env = setup(t, { manifestEntry, sources: [server.url] });
  mkdirSync(env.finalDir, { recursive: true });
  for (const name of SIDECAR_MODEL_FILES) writeFileSync(join(env.finalDir, name), 'truncated');
  assert.equal(env.manager.status().state, 'missing');
  env.manager.ensure();
  await env.ready();
  assert.deepEqual(readFileSync(join(env.finalDir, 'model.bin')), files.get('model.bin'));
});

test('startup cleanup removes partials of stale revisions but keeps the current one', async (t) => {
  const { files, manifestEntry } = fakeModel();
  const server = await startModelServer(t, files, { status: 503 });
  const env = setup(t, { manifestEntry, sources: [server.url], attemptsPerSource: 1 });
  const current = join(env.partialRoot, `${MODEL}@${manifestEntry.revision}`);
  const stale = join(env.partialRoot, `${MODEL}@${'b'.repeat(40)}`);
  for (const dir of [current, stale]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stale, 'model.bin'), 'old revision');
  env.manager.ensure();
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(current), true);
});

test('shutdown aborts an active download and settles without leaving a final directory', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 200_000 });
  const server = await startModelServer(t, files, { bodyDelayMs: 50 });
  const env = setup(t, { manifestEntry, sources: [server.url] });
  env.manager.ensure();
  await until(() => server.gets('model.bin').length > 0);
  await env.manager.shutdown();
  assert.equal(existsSync(env.finalDir), false);
  assert.notEqual(env.manager.status().state, 'downloading');
});

test('IPC handlers go through shared validation and report the current snapshot', async (t) => {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 100_000 });
  const server = await startModelServer(t, files, { bodyDelayMs: 30 });
  const env = setup(t, { manifestEntry, sources: [server.url] });
  const dispatch = createDispatcher({ models: createModelHandlers(env.manager) });

  assert.equal((await dispatch('models:get-status', [])).value.state, 'missing');
  assert.equal((await dispatch('models:get-status', ['extra'])).error.code, 'INVALID_INPUT');
  const started = await dispatch('models:download', []);
  assert.equal(started.value.state, 'downloading');
  const again = await dispatch('models:download', []);
  assert.equal(again.value.state, 'downloading', 'a second request joins the running download');
  const cancelled = await dispatch('models:cancel-download', []);
  assert.equal(cancelled.value.state, 'missing');
  await dispatch('models:download', []);
  await env.ready();
  assert.equal((await dispatch('models:download', [])).value.state, 'ready');
});

test('manifest invariants: sidecar files are covered, hashes and sizes are well-formed', () => {
  const worker = readFileSync(new URL('../services/asr-worker/worker.py', import.meta.url), 'utf8');
  const declared = worker.match(/^MODEL_FILES = \(([^)]*)\)/m)[1];
  const sidecar = [...declared.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...SIDECAR_MODEL_FILES].sort(), sidecar);

  for (const [name, entry] of Object.entries(MODEL_MANIFEST)) {
    assert.match(entry.revision, /^[0-9a-f]{40}$/, `${name} revision is pinned to a commit`);
    const names = entry.files.map((file) => file.name);
    for (const required of SIDECAR_MODEL_FILES) assert.ok(names.includes(required), required);
    for (const file of entry.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, file.name);
      assert.ok(Number.isInteger(file.size) && file.size > 0, file.name);
      assert.doesNotMatch(file.name, /[\\/]/, 'file names cannot escape the model directory');
    }
  }
  assert.ok(DEFAULT_MODEL_SOURCES.length >= 2, 'at least one fallback mirror');
  assert.ok(DEFAULT_MODEL_SOURCES.every((source) => source.startsWith('https://')));
  // 设置里的默认模型必须能下载，否则开箱即用不成立
  assert.ok(MODEL_MANIFEST.small);
});
