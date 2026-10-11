/**
 * Integration tests for DeepSeek mock server
 */

import { test } from 'node:test';
import { strictEqual, ok, rejects } from 'node:assert';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import mock server
const { startServer } = await import('./support/deepseek-mock-server.mjs');

// Load test fixtures
const fixturesPath = join(__dirname, 'fixtures');
const sampleTranscript = JSON.parse(
  await readFile(join(fixturesPath, 'sample-transcript.json'), 'utf-8'),
);

/**
 * Helper to make HTTP request to mock server
 */
async function callMockApi(port, transcriptText, mode = 'normal', options = {}) {
  const response = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mock-Mode': mode,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            'You are a meeting note generator. Extract structured information from the transcript.',
        },
        {
          role: 'user',
          content: transcriptText,
        },
      ],
    }),
    signal: options.signal,
  });

  return response;
}

/**
 * Helper to start server and ensure cleanup
 */
async function withMockServer(testFn) {
  const server = startServer(0);
  await once(server, 'listening');
  try {
    await testFn(server.address().port, server);
  } finally {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }
}

test('mock server - normal mode returns valid note structure', async () => {
  await withMockServer(async (port) => {
    const response = await callMockApi(port, sampleTranscript.fullText, 'normal');

    strictEqual(response.status, 200);
    strictEqual(response.headers.get('content-type'), 'application/json');

    const data = await response.json();

    // Verify DeepSeek API response structure
    ok(data.id, 'Response should have id');
    strictEqual(data.object, 'chat.completion');
    ok(data.choices, 'Response should have choices');
    strictEqual(data.choices.length, 1);

    // Parse the note from response
    const note = JSON.parse(data.choices[0].message.content);

    // Verify note structure matches MeetingNote interface
    ok(note.summary, 'Note should have summary');
    ok(Array.isArray(note.keyTopics), 'Note should have keyTopics array');
    ok(Array.isArray(note.decisions), 'Note should have decisions array');
    ok(Array.isArray(note.openQuestions), 'Note should have openQuestions array');
    ok(Array.isArray(note.actionItems), 'Note should have actionItems array');

    // Verify action items have required fields
    for (const item of note.actionItems) {
      ok(item.task, 'Action item should have task');
      ok(item.owner !== undefined, 'Action item should have owner');
      ok(item.dueDate !== undefined, 'Action item should have dueDate');
    }
  });
});

test('mock server - rate-limit mode returns 429', async () => {
  await withMockServer(async (port) => {
    const response = await callMockApi(port, sampleTranscript.fullText, 'rate-limit');

    strictEqual(response.status, 429);
    strictEqual(response.headers.get('retry-after'), '60');

    const data = await response.json();
    ok(data.error, 'Response should have error');
    strictEqual(data.error.type, 'rate_limit_error');
    ok(data.error.message.includes('Rate limit'), 'Error message should mention rate limit');
  });
});

test('mock server - timeout mode delays response', async () => {
  await withMockServer(async (port, server) => {
    await rejects(
      callMockApi(port, sampleTranscript.fullText, 'timeout', {
        signal: AbortSignal.timeout(200),
      }),
      { name: 'TimeoutError' },
    );
    strictEqual(server.getRequests()[0].mode, 'timeout');
    strictEqual(server.getRequests()[0].messages[1].content, sampleTranscript.fullText);
  });
});

test('mock server - invalid-json mode returns malformed response', async () => {
  await withMockServer(async (port) => {
    const response = await callMockApi(port, sampleTranscript.fullText, 'invalid-json');

    strictEqual(response.status, 200);

    const text = await response.text();

    // Should not be valid JSON
    try {
      JSON.parse(text);
      throw new Error('Should have thrown parse error');
    } catch (err) {
      ok(err instanceof SyntaxError, 'Should be JSON parse error');
    }
  });
});

test('mock server - handles empty transcript gracefully', async () => {
  await withMockServer(async (port) => {
    const response = await callMockApi(port, '', 'normal');

    strictEqual(response.status, 200);

    const data = await response.json();
    const note = JSON.parse(data.choices[0].message.content);

    // Should still return valid structure even with empty input
    ok(note.summary);
    ok(Array.isArray(note.keyTopics));
    ok(note.keyTopics.length > 0, 'Should have at least one default topic');
  });
});

test('mock server - extracts decisions from transcript', async () => {
  await withMockServer(async (port) => {
    const transcript =
      'We decided to launch next week. The team agreed to use React for the frontend.';
    const response = await callMockApi(port, transcript, 'normal');

    const data = await response.json();
    const note = JSON.parse(data.choices[0].message.content);

    ok(note.decisions.length > 0, 'Should extract decisions');
    ok(note.decisions[0].text, 'Decision should have text');
  });
});

test('mock server - returns 404 for unknown endpoints', async () => {
  await withMockServer(async (port) => {
    const response = await fetch(`http://localhost:${port}/unknown`, {
      method: 'POST',
    });

    strictEqual(response.status, 404);
  });
});

test('mock server - captures request messages for inspection', async () => {
  await withMockServer(async (port, server) => {
    const transcriptText = 'Project deadline is next Friday.';

    await callMockApi(port, transcriptText, 'normal');

    const requests = server.getRequests();
    strictEqual(requests.length, 1, 'Should capture one request');

    const captured = requests[0];
    ok(captured.messages, 'Should have messages array');
    ok(captured.timestamp, 'Should have timestamp');
    strictEqual(captured.mode, 'normal', 'Should capture mode');

    // Verify system message
    const systemMsg = captured.messages.find((m) => m.role === 'system');
    ok(systemMsg, 'Should have system message');
    strictEqual(
      systemMsg.content,
      'You are a meeting note generator. Extract structured information from the transcript.',
    );

    // Verify user message
    const userMsg = captured.messages.find((m) => m.role === 'user');
    ok(userMsg, 'Should have user message');
    strictEqual(userMsg.content, transcriptText, 'Should capture exact user transcript');
  });
});

test('mock server - detects missing or incorrect context', async () => {
  await withMockServer(async (port, server) => {
    // Send request with missing system context
    await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: 'Some transcript',
          },
        ],
      }),
    });

    const requests = server.getRequests();
    const captured = requests[requests.length - 1];

    // Assert: missing system message is detectable
    const systemMsg = captured.messages.find((m) => m.role === 'system');
    strictEqual(systemMsg, undefined, 'Should detect missing system message');
  });
});
