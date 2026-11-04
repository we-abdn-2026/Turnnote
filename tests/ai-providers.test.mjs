import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_PROVIDERS,
  BUILTIN_PROVIDER_PRESETS,
  DEEPSEEK_PROFILE,
  DeepSeekError,
  MAX_CUSTOM_PROVIDERS,
  MeetingStore,
  PROVIDER_URL_PROBLEMS,
  createDispatcher,
  createInvokeApi,
  createProviderCatalog,
  createProviderHandlers,
  createSessionServices,
  errorMessages,
  migrate,
  migrations,
  parseProviderUrl,
  profileFor,
  requestChatCompletion,
} from '../out/tests/runtime.mjs';
import { startServer } from './support/deepseek-mock-server.mjs';

const KEY = 'sk-provider-test-secret';
const SEGMENTS = [{ startMs: 0, endMs: 1000, text: 'We decided to ship on Friday.' }];
const MESSAGES = [
  { role: 'system', content: 'json' },
  { role: 'user', content: 'x' },
];
const errorCode = (code) => (error) => error.code === code;
const completion = (content = '{}') =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
    status: 200,
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, label = 'condition') {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail(`${label} not reached`);
}

/** 内存凭证存储：与 CredentialStore 同样的接口，不加密 */
function memoryCredentials(initial = {}) {
  const keys = new Map(Object.entries(initial));
  return {
    has: (provider) => keys.has(provider),
    get: (provider) => keys.get(provider) ?? null,
    set: (provider, key) => keys.set(provider, key),
    clear: (provider) => keys.delete(provider),
  };
}

function fixture(t, { keys = { deepseek: KEY }, provider } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-providers-')));
  const audioDirectory = join(root, 'audio');
  mkdirSync(audioDirectory);
  const store = new MeetingStore(join(root, 'turnnote.db'), audioDirectory);
  const credentials = memoryCredentials(keys);
  const events = [];
  const services = createSessionServices(store, {
    audioDirectory,
    modelsDirectory: join(root, 'models'),
    sidecar: () => assert.fail('no sidecar'),
    permissions: () => ({ microphone: 'unknown', screen: 'unknown' }),
    emitMeeting: (meeting) => events.push(meeting),
    emitProgress: () => {},
    credentials,
    provider,
  });
  const dispatch = createDispatcher(services.handlers);
  const api = createInvokeApi((channel, ...args) => dispatch(channel, args));
  t.after(async () => {
    await services.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  return {
    root,
    store,
    credentials,
    api,
    events,
    catalog: createProviderCatalog(store, credentials),
    transcribed(title = 'Planning') {
      const path = join(audioDirectory, `m${++n}.wav`);
      writeFileSync(path, 'audio');
      const meeting = store.createCaptured(title, path);
      const job = store.beginTranscription(meeting.id);
      store.completeTranscription(job.id, SEGMENTS);
      return meeting.id;
    },
  };
}
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const failureCode = (result) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.error.code;
};

test('provider URLs: https only, http only for this machine, no credentials or query, normalized', () => {
  const good = parseProviderUrl('  https://API.Example.com/v1/  ');
  assert.deepEqual(good, {
    ok: true,
    baseUrl: 'https://api.example.com/v1',
    host: 'api.example.com',
    local: false,
  });
  assert.equal(
    parseProviderUrl('https://gateway.example.com:8443/openai/v1').host,
    'gateway.example.com:8443',
  );
  for (const local of [
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080',
    'http://[::1]:1234/v1',
  ]) {
    const result = parseProviderUrl(local);
    assert.equal(result.ok && result.local, true, local);
  }
  const bad = {
    'not a url': 'format',
    '': 'format',
    'ftp://example.com/v1': 'scheme',
    'http://api.example.com/v1': 'scheme',
    'https://user:pass@api.example.com/v1': 'credentials',
    'https://api.example.com/v1?key=abc': 'query',
    'https://api.example.com/v1#frag': 'query',
  };
  for (const [input, problem] of Object.entries(bad)) {
    assert.deepEqual(parseProviderUrl(input), { ok: false, problem }, input);
    assert.ok(PROVIDER_URL_PROBLEMS[problem].length > 10);
  }
  // 看起来像本机的域名不算本机
  assert.equal(parseProviderUrl('http://localhost.evil.com/v1').ok, false);
});

test('built-in providers come from the shared presets and every URL is valid', () => {
  assert.deepEqual(
    BUILTIN_PROVIDERS.map((provider) => provider.id),
    BUILTIN_PROVIDER_PRESETS.map((preset) => preset.id),
  );
  for (const provider of BUILTIN_PROVIDERS) {
    assert.equal(provider.builtin, true);
    assert.equal(provider.defaultModel, provider.models[0]);
    assert.ok(parseProviderUrl(provider.baseUrl).ok, provider.id);
  }
  const ollama = BUILTIN_PROVIDERS.find((provider) => provider.id === 'ollama');
  assert.deepEqual([ollama.needsKey, ollama.local], [false, true]);
});

test('each provider gets its own request body: DeepSeek-only fields never reach other services', async () => {
  const bodies = {};
  for (const provider of BUILTIN_PROVIDERS) {
    await requestChatCompletion(
      { apiKey: provider.needsKey ? KEY : null, model: provider.defaultModel, messages: MESSAGES },
      {
        baseUrl: provider.baseUrl,
        profile: provider.request,
        fetch: async (url, init) => {
          bodies[provider.id] = { url, headers: init.headers, body: JSON.parse(init.body) };
          return completion();
        },
      },
    );
  }
  assert.deepEqual(bodies.deepseek.body.thinking, { type: 'disabled' });
  assert.equal(bodies.deepseek.body.max_tokens, 8192);
  assert.equal('thinking' in bodies.openai.body, false, 'OpenAI rejects unknown request fields');
  assert.equal('max_tokens' in bodies.openai.body, false);
  assert.equal(bodies.openai.body.max_completion_tokens, 8192);
  assert.equal('thinking' in bodies.ollama.body, false);
  assert.equal(bodies.ollama.body.max_tokens, 8192);
  assert.equal(bodies.openai.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(bodies.ollama.url, 'http://localhost:11434/v1/chat/completions');
  // 不需要 Key 的服务不发送 Authorization
  assert.equal('Authorization' in bodies.ollama.headers, false);
  assert.equal(bodies.openai.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(profileFor('unknown-service').extraBody, undefined);
  assert.equal(profileFor('deepseek'), DEEPSEEK_PROFILE);
});

test('a rejected request is reported as fixable, not as an unexpected error', async () => {
  const respond = (status) => async () => new Response('{}', { status });
  const attempt = (status) =>
    requestChatCompletion(
      { apiKey: KEY, model: 'm', messages: MESSAGES },
      { fetch: respond(status) },
    ).catch((error) => error);
  for (const status of [400, 404, 422]) {
    const error = await attempt(status);
    assert.ok(error instanceof DeepSeekError);
    assert.equal(error.code, 'AI_REQUEST_REJECTED', String(status));
    assert.equal(error.retryable, false);
  }
  assert.equal((await attempt(401)).code, 'DEEPSEEK_UNAUTHORIZED');
  assert.equal((await attempt(403)).code, 'DEEPSEEK_UNAUTHORIZED');
  assert.equal((await attempt(429)).code, 'DEEPSEEK_RATE_LIMITED');
  const unavailable = await attempt(503);
  assert.deepEqual([unavailable.code, unavailable.retryable], ['DEEPSEEK_UNAVAILABLE', true]);
  assert.doesNotMatch(
    errorMessages.API_KEY_MISSING + errorMessages.DEEPSEEK_UNAUTHORIZED,
    /DeepSeek/,
  );
});

test('no user-facing safe message names a specific vendor', () => {
  for (const [code, message] of Object.entries(errorMessages)) {
    assert.doesNotMatch(message, /deepseek|openai/i, code);
  }
});

test('catalog lists built-ins with key state; saving, editing and removing custom services is validated', (t) => {
  const f = fixture(t, { keys: { deepseek: KEY } });
  const list = f.catalog.list();
  const byId = Object.fromEntries(list.map((item) => [item.id, item]));
  assert.deepEqual([byId.deepseek.hasKey, byId.deepseek.ready], [true, true]);
  assert.deepEqual([byId.openai.hasKey, byId.openai.ready], [false, false]);
  assert.deepEqual([byId.ollama.hasKey, byId.ollama.ready, byId.ollama.local], [false, true, true]);
  assert.equal(byId.deepseek.host, 'api.deepseek.com');

  const saved = f.catalog.saveCustom({
    label: '公司网关',
    baseUrl: 'https://gateway.corp.example/openai/v1/',
    needsKey: true,
  });
  assert.match(saved.id, /^custom-[0-9a-f]{8}$/);
  assert.deepEqual(
    [saved.builtin, saved.host, saved.baseUrl, saved.ready, saved.models],
    [false, 'gateway.corp.example', 'https://gateway.corp.example/openai/v1', false, []],
  );

  // 编辑：同一个 id，名称和网址可以改
  const edited = f.catalog.saveCustom({
    id: saved.id,
    label: '公司网关 2',
    baseUrl: 'https://gw2.example/v1',
    needsKey: false,
  });
  assert.deepEqual([edited.id, edited.label, edited.ready], [saved.id, '公司网关 2', true]);
  assert.equal(f.catalog.list().filter((item) => !item.builtin).length, 1);

  const invalid = [
    { label: 'x', baseUrl: 'http://api.example.com/v1', needsKey: true }, // 非本机 http
    { label: 'x', baseUrl: 'https://u:p@api.example.com/v1', needsKey: true },
    { label: 'deepseek', baseUrl: 'https://a.example/v1', needsKey: true }, // 与内置重名（不分大小写）
    { label: '公司网关 2', baseUrl: 'https://b.example/v1', needsKey: true }, // 与已有自定义重名
    { id: 'deepseek', label: 'Hijack', baseUrl: 'https://evil.example/v1', needsKey: true }, // 不能改内置
    { id: 'custom-missing', label: 'Ghost', baseUrl: 'https://c.example/v1', needsKey: true },
  ];
  for (const input of invalid) {
    assert.throws(
      () => f.catalog.saveCustom(input),
      errorCode('INVALID_INPUT'),
      JSON.stringify(input),
    );
  }
  assert.equal(
    f.catalog.get('deepseek').baseUrl,
    'https://api.deepseek.com/v1',
    'built-ins are untouched',
  );
  assert.throws(() => f.catalog.removeCustom('deepseek'), errorCode('INVALID_INPUT'));
});

test('custom services are limited in number', (t) => {
  const f = fixture(t);
  for (let i = 0; i < MAX_CUSTOM_PROVIDERS; i++) {
    f.catalog.saveCustom({
      label: `Service ${i}`,
      baseUrl: `https://s${i}.example/v1`,
      needsKey: true,
    });
  }
  assert.throws(
    () =>
      f.catalog.saveCustom({
        label: 'One too many',
        baseUrl: 'https://more.example/v1',
        needsKey: true,
      }),
    errorCode('INVALID_INPUT'),
  );
});

test('removing the service in use switches settings back to the default and deletes its key', async (t) => {
  const f = fixture(t, { keys: { deepseek: KEY } });
  const custom = value(
    await f.api.providers.saveCustom({
      label: 'Mine',
      baseUrl: 'https://mine.example/v1',
      needsKey: true,
    }),
  );
  value(await f.api.settings.setApiKey(custom.id, 'sk-mine'));
  value(await f.api.settings.update({ noteProvider: custom.id, noteModel: 'my-model' }));
  assert.equal(f.credentials.has(custom.id), true);

  value(await f.api.providers.removeCustom(custom.id));
  const settings = value(await f.api.settings.get());
  assert.deepEqual([settings.noteProvider, settings.noteModel], ['deepseek', 'deepseek-flash']);
  assert.equal(f.credentials.has(custom.id), false, 'the orphaned key is deleted');
  assert.equal(f.credentials.has('deepseek'), true, 'other keys are untouched');
  assert.equal(failureCode(await f.api.providers.removeCustom(custom.id)), 'INVALID_INPUT');
});

test('IPC rejects unknown services for settings and keys, and validates arguments', async (t) => {
  const f = fixture(t);
  assert.equal(
    failureCode(await f.api.settings.update({ noteProvider: 'no-such' })),
    'INVALID_INPUT',
  );
  assert.equal(failureCode(await f.api.settings.setApiKey('no-such', 'sk-x')), 'INVALID_INPUT');
  assert.equal(f.credentials.has('no-such'), false, 'no orphan secret');
  for (const model of ['llama3.1:8b', 'openai/gpt-4o', 'Qwen/Qwen2.5-7B-Instruct', 'gpt-4o@2025']) {
    assert.equal(value(await f.api.settings.update({ noteModel: model })).noteModel, model);
  }
  for (const model of ['', ' ', '../x', 'a..b', 'bad model', '-start', 'x'.repeat(101)]) {
    assert.equal(
      failureCode(await f.api.settings.update({ noteModel: model })),
      'INVALID_INPUT',
      model,
    );
  }
  assert.equal(
    failureCode(
      await f.api.providers.saveCustom({
        label: '',
        baseUrl: 'https://a.example/v1',
        needsKey: true,
      }),
    ),
    'INVALID_INPUT',
  );
  assert.equal(
    failureCode(
      await f.api.providers.saveCustom({
        label: 'x'.repeat(41),
        baseUrl: 'https://a.example/v1',
        needsKey: true,
      }),
    ),
    'INVALID_INPUT',
  );
  assert.equal(
    failureCode(
      await f.api.providers.saveCustom({
        label: 'ok',
        baseUrl: 'https://a.example/v1',
        needsKey: true,
        extra: 1,
      }),
    ),
    'INVALID_INPUT',
  );
});

async function mockServer(t) {
  const server = startServer(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test('generation routes to the selected custom endpoint with its own key and records who wrote the note', async (t) => {
  const { server, baseUrl } = await mockServer(t);
  const f = fixture(t, { keys: { deepseek: 'sk-deepseek-only' } });
  const custom = value(
    await f.api.providers.saveCustom({ label: '本机网关', baseUrl, needsKey: true }),
  );
  value(await f.api.settings.setApiKey(custom.id, 'sk-custom-key'));
  value(await f.api.settings.update({ noteProvider: custom.id, noteModel: 'my/model:1b' }));

  const id = f.transcribed();
  value(await f.api.notes.generate(id));
  await until(() => f.store.get(id).status === 'ready', 'generated');

  const [request] = server.getRequests();
  assert.equal(request.model, 'my/model:1b');
  assert.equal(request.hasAuthorization, true);
  const note = value(await f.api.notes.getLatest(id));
  assert.deepEqual(note.generatedBy, {
    provider: custom.id,
    label: '本机网关',
    model: 'my/model:1b',
    local: true,
  });

  // 之后改名、删除服务商都不影响这一版的来源记录
  value(
    await f.api.providers.saveCustom({ id: custom.id, label: '改名了', baseUrl, needsKey: true }),
  );
  assert.equal(value(await f.api.notes.getLatest(id)).generatedBy.label, '本机网关');
  value(await f.api.providers.removeCustom(custom.id));
  assert.deepEqual(value(await f.api.notes.getLatest(id)).generatedBy, {
    provider: custom.id,
    label: '本机网关',
    model: 'my/model:1b',
    local: true,
  });

  // 用户编辑的版本没有来源
  const edited = value(await f.api.notes.saveEdit(id, note.note, note.version));
  assert.equal(edited.generatedBy, null);
});

test('a service that needs no key generates without one and sends no Authorization header', async (t) => {
  const { server, baseUrl } = await mockServer(t);
  const f = fixture(t, { keys: {} });
  const local = value(
    await f.api.providers.saveCustom({ label: '本机模型', baseUrl, needsKey: false }),
  );
  value(await f.api.settings.update({ noteProvider: local.id, noteModel: 'llama3.1:8b' }));
  const id = f.transcribed();
  value(await f.api.notes.generate(id));
  await until(() => f.store.get(id).status === 'ready', 'generated without key');
  assert.equal(server.getRequests()[0].hasAuthorization, false);

  // 需要 Key 的服务缺 Key 仍然在启动任务前拒绝，且不发请求
  const needing = value(
    await f.api.providers.saveCustom({ label: '要 Key', baseUrl, needsKey: true }),
  );
  value(await f.api.settings.update({ noteProvider: needing.id, noteModel: 'm' }));
  const before = server.getRequests().length;
  assert.equal(failureCode(await f.api.notes.generate(id)), 'API_KEY_MISSING');
  assert.equal(server.getRequests().length, before);
  assert.equal(f.store.get(id).status, 'ready');
});

test('a model the service does not know fails as AI_REQUEST_REJECTED with the transcript and notes intact', async (t) => {
  const f = fixture(t, {
    provider: {
      fetch: async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }),
    },
  });
  const id = f.transcribed();
  value(await f.api.settings.update({ noteModel: 'does-not-exist' }));
  value(await f.api.notes.generate(id));
  await until(() => f.store.get(id).status === 'failed', 'failed');
  assert.equal(f.store.get(id).lastError.code, 'AI_REQUEST_REJECTED');
  assert.deepEqual(f.store.getSegments(id), SEGMENTS);
  assert.equal(f.store.getLatestNote(id), null);
});

test('connection test: success, wrong key, wrong model and unreachable are told apart without sending meeting content', async (t) => {
  const f = fixture(t);
  const sent = [];
  const respond =
    (status, body = '{}') =>
    async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(body, { status });
    };
  const run = async (service, model, fetch) =>
    createDispatcher({
      providers: createProviderHandlers(f.catalog, f.credentials, { provider: { fetch } }),
    })('providers:test', [service, model]);

  const okBody = JSON.stringify({
    choices: [{ message: { content: '{"pong":true}' }, finish_reason: 'stop' }],
  });
  assert.equal((await run('deepseek', 'deepseek-flash', respond(200, okBody))).ok, true);
  assert.equal(sent[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(sent[0].body.max_tokens, 32, 'the probe is tiny');
  assert.equal(
    JSON.stringify(sent[0].body).includes('ship'),
    false,
    'no meeting content in the probe',
  );
  assert.equal(sent[0].headers.Authorization, `Bearer ${KEY}`);

  // 200 但内容不合要求：Key、网址、模型都没问题，仍然算可用
  const truncated = JSON.stringify({
    choices: [{ message: { content: '{' }, finish_reason: 'length' }],
  });
  assert.equal((await run('deepseek', 'deepseek-flash', respond(200, truncated))).ok, true);

  assert.equal(
    failureCode(await run('deepseek', 'deepseek-flash', respond(401))),
    'DEEPSEEK_UNAUTHORIZED',
  );
  assert.equal(
    failureCode(await run('deepseek', 'no-such-model', respond(404))),
    'AI_REQUEST_REJECTED',
  );
  assert.equal(failureCode(await run('deepseek', 'm', respond(503))), 'DEEPSEEK_UNAVAILABLE');
  assert.equal(
    failureCode(
      await run('deepseek', 'm', async () => {
        throw new TypeError('fetch failed');
      }),
    ),
    'DEEPSEEK_UNAVAILABLE',
  );
  // 没有 Key 的服务直接提示缺 Key，不发请求；不存在的服务是非法输入
  const before = sent.length;
  assert.equal(failureCode(await run('openai', 'gpt-4o', respond(200, okBody))), 'API_KEY_MISSING');
  assert.equal(failureCode(await run('nope', 'm', respond(200, okBody))), 'INVALID_INPUT');
  assert.equal(sent.length, before);
});

test('migration 4 upgrades existing databases: notes keep their content with an unknown origin', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'turnnote-m4-'));
  const path = join(directory, 'old.db');
  const db = new Database(path);
  t.after(() => {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  migrate(db, migrations.slice(0, 3));
  db.prepare('INSERT INTO meetings(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(
    'm',
    'Old',
    'ready',
    'now',
    'now',
  );
  const note = {
    summary: 'Old note',
    keyTopics: [],
    decisions: [],
    openQuestions: [],
    actionItems: [],
  };
  db.prepare('INSERT INTO note_versions VALUES(?,?,?,?,?)').run(
    'm',
    1,
    'generated',
    JSON.stringify(note),
    'now',
  );
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  const row = db.prepare('SELECT generated_by FROM note_versions').get();
  assert.equal(row.generated_by, null);
  assert.throws(() => db.prepare("UPDATE note_versions SET generated_by = 'not json'").run());
  assert.throws(() =>
    db
      .prepare("INSERT INTO custom_providers VALUES('', 'x', 'https://a.example/v1', 1, 'now')")
      .run(),
  );
  db.close();

  const store = new MeetingStore(path, join(directory, 'audio'));
  t.after(() => store.close());
  assert.deepEqual(store.getLatestNote('m').generatedBy, null);
  assert.equal(store.getLatestNote('m').note.summary, 'Old note');
});

test('a stored origin without the local flag is treated as non-local (remind rather than miss)', (t) => {
  const f = fixture(t);
  const id = f.transcribed();
  const job = f.store.beginGeneration(id);
  f.store.completeGeneration(
    job.id,
    { summary: 's', keyTopics: [], decisions: [], openQuestions: [], actionItems: [] },
    {
      provider: 'deepseek',
      label: 'DeepSeek',
      model: 'deepseek-flash',
      local: false,
    },
  );
  const db = new Database(join(f.root, 'turnnote.db'));
  t.after(() => db.close());
  db.prepare('UPDATE note_versions SET generated_by = ?').run(
    JSON.stringify({ provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-flash' }),
  );
  assert.equal(f.store.getLatestNote(id).generatedBy.local, false);
});
