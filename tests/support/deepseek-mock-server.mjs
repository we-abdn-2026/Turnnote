/**
 * DeepSeek Mock Server for Integration Tests
 *
 * Simulates DeepSeek Chat Completion API with four response modes:
 * - normal: Returns structured meeting note
 * - rate-limit: Returns 429 rate limit error
 * - timeout: Delays response by 30 seconds
 * - invalid-json: Returns malformed JSON response
 *
 * Usage:
 *   node tests/support/deepseek-mock-server.mjs [--port=3456]
 *
 * Control mode via request header:
 *   X-Mock-Mode: normal|rate-limit|timeout|invalid-json
 *
 * API endpoint:
 *   POST http://localhost:3456/v1/chat/completions
 */

import { createServer } from 'node:http';
import { parse as parseUrl } from 'node:url';

const DEFAULT_PORT = 3456;
const TIMEOUT_DELAY_MS = 30000;

/**
 * Generate a structured meeting note from transcript text
 * Simple keyword-based extraction for testing purposes
 */
function generateNoteFromTranscript(transcriptText) {
  const text = transcriptText.toLowerCase();

  // Extract key topics based on common meeting keywords
  const keyTopics = [];
  if (text.includes('launch') || text.includes('release')) keyTopics.push('Product Launch');
  if (text.includes('pricing') || text.includes('price')) keyTopics.push('Pricing Strategy');
  if (text.includes('timeline') || text.includes('deadline')) keyTopics.push('Timeline');
  if (text.includes('budget') || text.includes('cost')) keyTopics.push('Budget');
  if (keyTopics.length === 0) keyTopics.push('General Discussion');

  // Extract decisions (look for "decided", "agreed", "will")
  const decisions = [];
  const decisionPatterns = [
    /(?:decided|agreed|will)\s+(?:to\s+)?([^.!?]+)/gi,
    /(?:我们|团队)(?:决定|同意|将要)([^。！？]+)/gi
  ];

  for (const pattern of decisionPatterns) {
    let match;
    while ((match = pattern.exec(transcriptText)) !== null) {
      const decision = match[1].trim();
      if (decision.length > 10 && decision.length < 100) {
        decisions.push({ text: decision });
        if (decisions.length >= 3) break;
      }
    }
  }

  if (decisions.length === 0) {
    decisions.push({ text: 'Proceed with current plan as discussed' });
  }

  // Extract action items (look for names + "will", "should", "needs to")
  const actionItems = [];
  const actionPatterns = [
    /([A-Z][a-z]+)\s+(?:will|should|needs to)\s+([^.!?]+)/g,
    /([A-Z][a-z]+)\s+(?:负责|将要|需要)([^。！？]+)/g
  ];

  for (const pattern of actionPatterns) {
    let match;
    while ((match = pattern.exec(transcriptText)) !== null) {
      const owner = match[1].trim();
      const task = match[2].trim();
      if (task.length > 5 && task.length < 100) {
        actionItems.push({
          task,
          owner,
          dueDate: 'unspecified'
        });
        if (actionItems.length >= 3) break;
      }
    }
  }

  if (actionItems.length === 0) {
    actionItems.push({
      task: 'Follow up on discussed topics',
      owner: 'unspecified',
      dueDate: 'unspecified'
    });
  }

  // Extract open questions (look for "?", "unclear", "TBD")
  const openQuestions = [];
  const questionMatches = transcriptText.match(/[^.!?]*\?/g) || [];
  for (const q of questionMatches.slice(0, 3)) {
    const cleaned = q.trim();
    if (cleaned.length > 10) {
      openQuestions.push(cleaned);
    }
  }

  if (openQuestions.length === 0 && (text.includes('unclear') || text.includes('tbd') || text.includes('open'))) {
    openQuestions.push('Some details remain to be clarified');
  }

  // Generate summary
  const summary = `Meeting discussion covered ${keyTopics.join(', ').toLowerCase()} with ${decisions.length} key decision(s) and ${actionItems.length} action item(s).`;

  return {
    summary,
    keyTopics,
    decisions,
    openQuestions,
    actionItems
  };
}

/**
 * Handle incoming requests
 */
function handleRequest(req, res) {
  const url = parseUrl(req.url, true);

  // Only handle POST /v1/chat/completions
  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
    return;
  }

  // Parse request body
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    try {
      const requestData = JSON.parse(body);
      const mode = req.headers['x-mock-mode'] || 'normal';

      // Extract transcript text from messages
      const messages = requestData.messages || [];
      let transcriptText = '';
      for (const msg of messages) {
        if (msg.role === 'user' && msg.content) {
          transcriptText += msg.content + ' ';
        }
      }

      // Handle different modes
      switch (mode) {
        case 'rate-limit':
          handleRateLimitMode(res);
          break;

        case 'timeout':
          handleTimeoutMode(res, transcriptText);
          break;

        case 'invalid-json':
          handleInvalidJsonMode(res);
          break;

        case 'normal':
        default:
          handleNormalMode(res, transcriptText);
          break;
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Invalid JSON in request body',
          type: 'invalid_request_error'
        }
      }));
    }
  });
}

/**
 * Normal mode: Return structured note
 */
function handleNormalMode(res, transcriptText) {
  const note = generateNoteFromTranscript(transcriptText);

  // Format as DeepSeek API response with JSON mode
  const response = {
    id: 'chatcmpl-mock-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(note)
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: Math.floor(transcriptText.length / 4),
      completion_tokens: 150,
      total_tokens: Math.floor(transcriptText.length / 4) + 150
    }
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/**
 * Rate limit mode: Return 429 error
 */
function handleRateLimitMode(res) {
  const response = {
    error: {
      message: 'Rate limit exceeded. Please try again later.',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded'
    }
  };

  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': '60'
  });
  res.end(JSON.stringify(response));
}

/**
 * Timeout mode: Delay response by 30 seconds
 */
function handleTimeoutMode(res, transcriptText) {
  setTimeout(() => {
    handleNormalMode(res, transcriptText);
  }, TIMEOUT_DELAY_MS);
}

/**
 * Invalid JSON mode: Return malformed response
 */
function handleInvalidJsonMode(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  // Intentionally malformed JSON
  res.end('{ "choices": [ { "message": { "content": INVALID JSON }');
}

/**
 * Start the server
 */
function startServer(port = DEFAULT_PORT) {
  const server = createServer(handleRequest);

  server.listen(port, () => {
    console.log(`DeepSeek mock server running on http://localhost:${port}`);
    console.log(`Endpoint: POST /v1/chat/completions`);
    console.log(`Modes: normal (default), rate-limit, timeout, invalid-json`);
    console.log(`Control via header: X-Mock-Mode: <mode>`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down mock server...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  return server;
}

// Parse command line arguments
const args = process.argv.slice(2);
let port = DEFAULT_PORT;

for (const arg of args) {
  if (arg.startsWith('--port=')) {
    port = parseInt(arg.split('=')[1], 10);
  }
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer(port);
}

// Export for testing
export { startServer, generateNoteFromTranscript };
