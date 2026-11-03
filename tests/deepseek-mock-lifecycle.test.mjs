import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { once } from 'node:events';
import { request } from 'node:http';
import { startServer } from './support/deepseek-mock-server.mjs';

async function stop(server) {
  const closed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

async function post(port, messages, mode) {
  const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: mode ? { 'X-Mock-Mode': mode } : {},
    body: JSON.stringify({ messages }),
  });
  await response.text();
  return response;
}

async function withServer(fn) {
  const server = startServer(0);
  await once(server, 'listening');
  try {
    await fn(server, server.address().port);
  } finally {
    await stop(server);
  }
}

test('capture preserves Chinese split inside a UTF-8 character', { timeout: 5000 }, async () => {
  await withServer(async (server, port) => {
    const messages = [
      { role: 'system', content: '会议上下文：讨论发布计划。' },
      { role: 'user', content: '我们决定下周发布，负责人是小明。' },
    ];
    const body = Buffer.from(JSON.stringify({ messages }));
    const split = body.indexOf(Buffer.from('会')) + 1;
    // Wait for the first real server-side data event, not a timing guess.
    const firstChunk = new Promise((resolve) => {
      server.once('request', (incoming) => incoming.once('data', resolve));
    });
    const outgoing = request({
      hostname: 'localhost',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const responsePromise = once(outgoing, 'response');
    outgoing.write(body.subarray(0, split));
    await firstChunk;
    outgoing.end(body.subarray(split));
    const [response] = await responsePromise;
    response.resume();
    await once(response, 'end');
    strictEqual(response.statusCode, 200);
    deepStrictEqual(server.getRequests()[0].messages, messages);
  });
});

test('capture returns independent deep snapshots, not a live log', async () => {
  await withServer(async (server, port) => {
    const messages = [
      { role: 'system', content: '会议上下文', metadata: { topic: 'release' } },
      { role: 'user', content: '发布转写' },
    ];
    await post(port, messages);
    const expected = structuredClone(server.getRequests());
    const earlier = server.getRequests();
    const snapshot = server.getRequests();
    snapshot[0].messages[0].metadata.topic = 'mutated';
    snapshot[0].messages[1].content = 'mutated';
    snapshot[0].mode = 'timeout';
    snapshot.push({ messages: [] });
    deepStrictEqual(server.getRequests(), expected);
    await post(port, [{ role: 'user', content: 'second' }], 'rate-limit');
    deepStrictEqual(earlier, expected);
    strictEqual(server.getRequests().length, 2);
  });
});

test('capture is ordered, isolated per instance, and retained after close', async () => {
  let closedServer;
  let snapshot;
  let portToReuse;
  await withServer(async (first, firstPort) => {
    closedServer = first;
    portToReuse = firstPort;
    await withServer(async (second, secondPort) => {
      const messages = [
        { role: 'system', content: '会议上下文' },
        { role: 'user', content: '用户转写' },
      ];
      for (const [mode, status] of [
        [undefined, 200],
        ['rate-limit', 429],
        ['invalid-json', 200],
      ]) {
        strictEqual((await post(firstPort, messages, mode)).status, status);
      }
      deepStrictEqual(second.getRequests(), []);
      await post(secondPort, [{ role: 'user', content: '独立实例' }]);
      deepStrictEqual(
        first.getRequests().map(({ mode, messages: captured }) => ({ mode, messages: captured })),
        ['normal', 'rate-limit', 'invalid-json'].map((mode) => ({ mode, messages })),
      );
      strictEqual(second.getRequests().length, 1);
      snapshot = first.getRequests();
    });
  });
  deepStrictEqual(closedServer.getRequests(), snapshot);
  // Rebind the exact port only after awaited shutdown; the new instance is empty.
  const fresh = startServer(portToReuse);
  try {
    await once(fresh, 'listening');
    deepStrictEqual(fresh.getRequests(), []);
  } finally {
    await stop(fresh);
  }
});

test(
  'closing active timeout connections releases the port and timer',
  { timeout: 5000 },
  async () => {
    await withServer(async (server, port) => {
      const received = new Promise((resolve) => {
        server.once('request', (incoming) => incoming.once('end', resolve));
      });
      const outgoing = request({
        hostname: 'localhost',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'X-Mock-Mode': 'timeout' },
      });
      const failed = once(outgoing, 'error');
      outgoing.end(JSON.stringify({ messages: [{ role: 'user', content: '延迟请求' }] }));
      await received;
      deepStrictEqual(
        server.getRequests().map(({ mode, messages }) => ({ mode, messages })),
        [{ mode: 'timeout', messages: [{ role: 'user', content: '延迟请求' }] }],
      );
      // The helper stops the listener, destroys active connections, and awaits close.
      server.closeAllConnections();
      const [error] = await failed;
      strictEqual(error.code, 'ECONNRESET');
    });
  },
);
