# DeepSeek Mock Server

Local HTTP test utility for `POST /v1/chat/completions`. Requires Node.js 24,
uses only Node standard libraries, and needs no API key or external service.
Use synthetic meeting content only. This is not a production service: the Node
listener uses the default host (all interfaces), so use an isolated dev/CI host.

## CLI startup and shutdown

```bash
node tests/support/deepseek-mock-server.mjs             # port 3456
node tests/support/deepseek-mock-server.mjs --port=8080 # chosen port
node tests/support/deepseek-mock-server.mjs --port=0    # OS-assigned free port
```

Wait for `DeepSeek mock server running on http://localhost:<actual-port>` before
sending requests. An occupied port produces a listen error rather than readiness.
On POSIX, Ctrl+C (`SIGINT`) or `SIGTERM` stops listening, destroys active connections
(including unfinished requests and timeout responses), and prints `Server closed`.
The process exits naturally; response timers are cancelled on disconnect. Wait for
process exit before reusing the port. Windows POSIX signal delivery is not portable;
use the programmatic cleanup pattern below there. Signal tests skip on Windows.

## Deterministic response selection

Set `X-Mock-Mode` on each request; there is no random fault injection.

| Header value | Response | What to assert |
|---|---|---|
| `normal` (default) | HTTP 200, OpenAI-compatible completion envelope | `choices[0].message.content` is a JSON-stringified meeting note |
| `rate-limit` | HTTP 429, `Retry-After: 60` | Error type `rate_limit_error`, code `rate_limit_exceeded` |
| `timeout` | Response delayed 30 seconds | A shorter client deadline aborts; disconnect cancels the response timer |
| `invalid-json` | HTTP 200 with malformed outer JSON | Response JSON parsing fails |

Missing or unknown mode headers produce a normal response. An unknown header value
is still recorded as supplied. IDs, creation times and capture timestamps depend on
the clock; assert payload semantics, not fixed values for these fields.

```bash
# Replace normal with rate-limit or invalid-json to exercise those modes.
curl -X POST http://localhost:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Mock-Mode: normal' \
  -d '{"model":"deepseek-chat","messages":[{"role":"system","content":"Generate meeting notes."},{"role":"user","content":"We decided to launch next week. Alex will prepare documentation."}]}'

# Expected curl exit code 28 after two seconds; no response yet.
curl --max-time 2 -X POST http://localhost:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Mock-Mode: timeout' \
  -d '{"messages":[{"role":"user","content":"Synthetic meeting transcript"}]}'
```

Normal notes contain `summary`, `keyTopics`, `decisions`, `openQuestions` and
`actionItems`. Generation uses simple keyword/pattern extraction, not inference.
See [sample-transcript.json](../fixtures/sample-transcript.json) and
[expected-note.json](../fixtures/expected-note.json) for synthetic fixtures.

## Request capture and lifecycle

Save this runnable example under `tests/` and run `node --test tests/<file>.test.mjs`:

```javascript
import { test } from 'node:test';
import { deepStrictEqual } from 'node:assert';
import { once } from 'node:events';
import { startServer } from './support/deepseek-mock-server.mjs';

test('client sends system context and the exact transcript', async () => {
  const server = startServer(0); // OS-assigned port, no random collisions
  await once(server, 'listening'); // rejects on listen errors, no startup sleeps
  const endpoint = `http://localhost:${server.address().port}/v1/chat/completions`;
  const messages = [
    { role: 'system', content: '会议上下文：讨论发布计划。' },
    { role: 'user', content: '我们决定下周发布。' },
  ];
  try {
    // Replace fetch with the API client under test, configured for this endpoint.
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mock-Mode': 'normal' },
      body: JSON.stringify({ model: 'deepseek-chat', messages }),
    });
    await response.json();
    deepStrictEqual(server.getRequests()[0].messages, messages);
  } finally {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    // close() alone waits for active requests; timeout mode could take 30s.
    server.closeAllConnections();
    await closed;
  }
});
```

`server.getRequests()` returns a **deep, independent snapshot** of
`{ timestamp, mode, messages }` records. Changing its array, records or nested
messages cannot change the server log; earlier snapshots do not grow with later
requests. `timestamp` is epoch milliseconds when the complete body is parsed.
Records follow **body parsing order**, not TCP connection arrival order.

All four modes record messages before dispatch, including timeout requests that
clients later abort. Missing messages become `[]`; malformed JSON and requests to
other endpoints are not captured. The mock captures context but **does not require
or validate a system message**: client tests must assert that themselves. Chinese
UTF-8 characters split across network chunks are preserved.

Each `startServer()` creates a fresh independent log. `server.close()` stops the
listener but **does not erase records**: they remain readable while the server is
referenced. Snapshots live as long as callers reference them. Release both the
server and snapshots after assertions to allow garbage collection. A new instance
starts empty, even on a reused port. Records are never printed or written to disk
by the server. Capture is unbounded and intended only for short-lived tests.
No HTTP inspection endpoint exists; use the imported server object for assertions.

## Self-tests and CI

```bash
npm test -- tests/deepseek-mock.test.mjs tests/deepseek-mock-lifecycle.test.mjs tests/deepseek-mock-cli.test.mjs
# Or, without installing project dependencies (mock-only):
node --test tests/deepseek-mock*.test.mjs
```

`npm test` and CI `check` automatically discover all three suites. They cover:

- Normal note structure, 429 and exact Retry-After, client timeout, malformed JSON.
- Exact system/user text, missing context, Chinese split inside a UTF-8 character.
- Deep snapshot mutation safety, record order, per-instance isolation and retained
  records after close; fresh capture and successful rebind on the same port.
- Active timeout connection cleanup, ephemeral-port CLI readiness, SIGINT/SIGTERM
  exit and port release (POSIX).

## Limits

- Keyword extraction is simplistic; no streaming, authentication or API-key checks.
- Only the chat-completions endpoint is modeled; no real conversation history.
- Invalid JSON mode corrupts the outer HTTP payload, not just the assistant content.
- This verifies the mock, not a production API client's retry policy, real DeepSeek
  inference, desktop packaging, or macOS/Windows platform behavior.

Implementation: [deepseek-mock-server.mjs](deepseek-mock-server.mjs).
