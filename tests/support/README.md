# DeepSeek Mock Server

Mock HTTP server that simulates the DeepSeek Chat Completion API for testing purposes.

## Features

- ✅ Simulates DeepSeek API `/v1/chat/completions` endpoint
- ✅ Four response modes: normal, rate-limit, timeout, invalid-json
- ✅ Keyword-based note generation from transcript text
- ✅ No external dependencies (uses Node.js built-in modules only)
- ✅ Controllable via request headers

## Usage

### Starting the Server

```bash
# Default port (3456)
node tests/support/deepseek-mock-server.mjs

# Custom port
node tests/support/deepseek-mock-server.mjs --port=8080
```

### Making Requests

The server exposes a single endpoint: `POST /v1/chat/completions`

#### Normal Mode (Default)

Returns a structured meeting note generated from the transcript.

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Mock-Mode: normal" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {
        "role": "user",
        "content": "We decided to launch next week. Alex will prepare the documentation."
      }
    ]
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-mock-1234567890",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"summary\":\"Meeting discussion covered...\",\"keyTopics\":[...],\"decisions\":[...],\"openQuestions\":[...],\"actionItems\":[...]}"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 50,
    "completion_tokens": 150,
    "total_tokens": 200
  }
}
```

#### Rate Limit Mode

Returns a 429 error to simulate API rate limiting.

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Mock-Mode: rate-limit" \
  -d '{...}'
```

**Response (429):**
```json
{
  "error": {
    "message": "Rate limit exceeded. Please try again later.",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}
```

#### Timeout Mode

Delays the response by 30 seconds to simulate network timeout.

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Mock-Mode: timeout" \
  -d '{...}'
```

#### Invalid JSON Mode

Returns malformed JSON to simulate parsing errors.

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Mock-Mode: invalid-json" \
  -d '{...}'
```

## Response Modes

| Mode | Header Value | Description | Use Case |
|------|-------------|-------------|----------|
| Normal | `normal` | Returns valid structured note | Happy path testing |
| Rate Limit | `rate-limit` | Returns 429 with retry-after | Test rate limit handling |
| Timeout | `timeout` | Delays response 30 seconds | Test timeout handling |
| Invalid JSON | `invalid-json` | Returns malformed JSON | Test error recovery |

## Note Generation Logic

The mock server uses simple keyword extraction to generate meeting notes:

### Key Topics
- Detects: launch, release, pricing, budget, timeline
- Default: "General Discussion"

### Decisions
- Pattern: "decided", "agreed", "will"
- Extracts text following decision keywords

### Action Items
- Pattern: "[Name] will/should/needs to [task]"
- Extracts owner and task
- Sets dueDate to "unspecified"

### Open Questions
- Extracts sentences ending with "?"
- Detects: "unclear", "TBD", "open"

## Integration with Tests

See [tests/deepseek-mock.test.mjs](../deepseek-mock.test.mjs) for integration test examples.

### Basic Test Pattern

```javascript
import { startServer } from './support/deepseek-mock-server.mjs';

const server = startServer(3456);

// Make requests to http://localhost:3456

server.close();
```

## Fixtures

Sample test data is available in [tests/fixtures/](../fixtures/):

- `sample-transcript.json` - Example transcript with segments
- `expected-note.json` - Expected note structure

## API Compatibility

The mock server matches DeepSeek API response format:

- Response structure follows OpenAI-compatible format
- `choices[0].message.content` contains JSON-stringified note
- Usage statistics included in response
- Error responses match DeepSeek error format

## Limitations

- Keyword extraction is simplistic (not AI-based)
- No streaming support
- No authentication/API key validation
- Single endpoint only
- No conversation history support

## Development

To modify the note generation logic, edit the `generateNoteFromTranscript()` function in [deepseek-mock-server.mjs](deepseek-mock-server.mjs:23).

## Running Tests

```bash
npm test -- tests/deepseek-mock.test.mjs
```

All tests should pass:
- ✅ Normal mode returns valid note structure
- ✅ Rate-limit mode returns 429
- ✅ Timeout mode delays response
- ✅ Invalid-json mode returns malformed response
- ✅ Handles empty transcript gracefully
- ✅ Extracts decisions from transcript
- ✅ Returns 404 for unknown endpoints
