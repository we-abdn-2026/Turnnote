import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './support/deepseek-mock-server.mjs';
import {
  DeepSeekError,
  MAX_OUTPUT_TOKENS,
  NOTE_RESPONSE_FORMAT,
  buildNoteMessages,
  parseNoteResponse,
  requestChatCompletion,
} from '../out/tests/runtime.mjs';

const API_KEY = 'sk-test-secret-value';
const MESSAGES = buildNoteMessages([{ startMs: 0, endMs: 1000, text: 'We decided to ship.' }]);
const request = (overrides = {}) => ({
  apiKey: API_KEY,
  model: 'deepseek-flash',
  messages: MESSAGES,
  ...overrides,
});
const deepseekError = (code, retryable) => (error) =>
  error instanceof DeepSeekError &&
  error.code === code &&
  error.retryable === retryable &&
  !error.message.includes(API_KEY) &&
  !error.message.includes('ship');
const completion = (content, finish_reason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }), {
    status: 200,
  });

async function mock(t) {
  const server = startServer(0);
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const withMode = (mode) => (url, init) =>
    fetch(url, { ...init, headers: { ...init.headers, 'X-Mock-Mode': mode } });
  return { server, baseUrl, withMode };
}

test('request sends only the given messages with JSON Output and returns content', async (t) => {
  const { server, baseUrl } = await mock(t);
  const content = await requestChatCompletion(request(), { baseUrl: `${baseUrl}/` });
  assert.ok(parseNoteResponse(content).summary.length > 0);
  const [recorded] = server.getRequests();
  assert.deepEqual(recorded.messages, MESSAGES);

  let sent;
  await requestChatCompletion(request(), {
    fetch: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return completion('{}');
    },
  });
  assert.equal(sent.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(sent.body, {
    model: 'deepseek-flash',
    messages: MESSAGES,
    response_format: NOTE_RESPONSE_FORMAT,
    thinking: { type: 'disabled' },
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
  });
});

test('mock rate limit, invalid JSON and timeout map to stable codes', async (t) => {
  const { baseUrl, withMode } = await mock(t);
  await assert.rejects(
    requestChatCompletion(request(), { baseUrl, fetch: withMode('rate-limit') }),
    deepseekError('DEEPSEEK_RATE_LIMITED', true),
  );
  await assert.rejects(
    requestChatCompletion(request(), { baseUrl, fetch: withMode('invalid-json') }),
    deepseekError('DEEPSEEK_INVALID_RESPONSE', false),
  );
  const started = Date.now();
  await assert.rejects(
    requestChatCompletion(request(), { baseUrl, fetch: withMode('timeout'), timeoutMs: 100 }),
    deepseekError('DEEPSEEK_TIMEOUT', true),
  );
  assert.ok(Date.now() - started < 5_000);
});

test('HTTP status codes map to stable codes without reading the error body', async () => {
  const cases = [
    [401, 'DEEPSEEK_UNAUTHORIZED', false],
    [403, 'DEEPSEEK_UNAUTHORIZED', false],
    [402, 'DEEPSEEK_UNAVAILABLE', false],
    [400, 'INTERNAL', false],
    [422, 'INTERNAL', false],
    [429, 'DEEPSEEK_RATE_LIMITED', true],
    [500, 'DEEPSEEK_UNAVAILABLE', true],
    [503, 'DEEPSEEK_UNAVAILABLE', true],
  ];
  for (const [status, code, retryable] of cases) {
    const fetchStub = async () =>
      new Response(JSON.stringify({ error: { message: `echo ${API_KEY} ship` } }), { status });
    await assert.rejects(
      requestChatCompletion(request(), { fetch: fetchStub }),
      deepseekError(code, retryable),
      String(status),
    );
  }
});

test('truncated, empty, filtered and malformed completions are invalid responses', async () => {
  const cases = [
    completion('{"summary": "cut', 'length'),
    completion('{}', 'content_filter'),
    completion(''),
    completion('   '),
    completion(null),
    new Response('{"choices": []}', { status: 200 }),
    new Response('{"choices": [{"message": {}}]}', { status: 200 }),
    new Response('not json', { status: 200 }),
  ];
  for (const response of cases) {
    await assert.rejects(
      requestChatCompletion(request(), { fetch: async () => response }),
      deepseekError('DEEPSEEK_INVALID_RESPONSE', false),
    );
  }
  await assert.rejects(
    requestChatCompletion(request(), {
      fetch: async () => completion('{}', 'insufficient_system_resource'),
    }),
    deepseekError('DEEPSEEK_UNAVAILABLE', true),
  );
});

test('network failure is retryable; caller abort is INTERRUPTED, before or during the request', async () => {
  await assert.rejects(
    requestChatCompletion(request(), {
      fetch: async () => {
        throw new TypeError(`fetch failed for ${API_KEY}`);
      },
    }),
    deepseekError('DEEPSEEK_UNAVAILABLE', true),
  );

  let called = false;
  const aborted = AbortSignal.abort();
  await assert.rejects(
    requestChatCompletion(request({ signal: aborted }), {
      fetch: async () => {
        called = true;
        return completion('{}');
      },
    }),
    deepseekError('INTERRUPTED', false),
  );
  assert.equal(called, false);

  const controller = new AbortController();
  const pending = requestChatCompletion(request({ signal: controller.signal }), {
    fetch: (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      ),
  });
  controller.abort();
  await assert.rejects(pending, deepseekError('INTERRUPTED', false));
});
