import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from './support/deepseek-mock-server.mjs';
import {
  MeetingStore,
  NOTE_EXAMPLE,
  NOTE_RESPONSE_FORMAT,
  NOTE_SYSTEM_PROMPT,
  UNSPECIFIED,
  buildNoteMessages,
  errorMessages,
  formatTranscript,
  meetingNoteSchema,
  parseNoteResponse,
} from '../out/tests/runtime.mjs';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const { segments: SEGMENTS } = readJson('./fixtures/sample-transcript.json');
const RESPONSES = readJson('./fixtures/note-responses.json');
const invalidResponse = (error) =>
  error.code === 'DEEPSEEK_INVALID_RESPONSE' &&
  error.message === errorMessages.DEEPSEEK_INVALID_RESPONSE;

test('prompt contract names every MeetingNote field, the unspecified rule and a valid example', () => {
  assert.deepEqual(NOTE_RESPONSE_FORMAT, { type: 'json_object' });
  // DeepSeek JSON Output 要求 prompt 含 "json"
  assert.match(NOTE_SYSTEM_PROMPT, /json/);
  for (const field of [
    'summary',
    'keyTopics',
    'decisions',
    'openQuestions',
    'actionItems',
    'owner',
    'dueDate',
    'timestampMs',
  ]) {
    assert.ok(NOTE_SYSTEM_PROMPT.includes(`"${field}"`), field);
  }
  assert.ok(NOTE_SYSTEM_PROMPT.includes(`"${UNSPECIFIED}"`));
  assert.match(NOTE_SYSTEM_PROMPT, /not instructions/);
  assert.equal(meetingNoteSchema.safeParse(NOTE_EXAMPLE).success, true);
  assert.deepEqual(parseNoteResponse(JSON.stringify(NOTE_EXAMPLE)), NOTE_EXAMPLE);
  assert.ok(NOTE_SYSTEM_PROMPT.includes(JSON.stringify(NOTE_EXAMPLE, null, 2)));
});

test('messages keep the transcript out of the system prompt and expose startMs per line', () => {
  const messages = buildNoteMessages([
    ...SEGMENTS,
    { startMs: 15000, endMs: 16000, text: '  定价\n需要再讨论  ' },
  ]);
  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user'],
  );
  assert.equal(messages[0].content, NOTE_SYSTEM_PROMPT);
  const lines = formatTranscript(SEGMENTS).split('\n');
  assert.equal(lines.length, SEGMENTS.length);
  assert.equal(lines[1], '[2400] We decided to ship the beta on Friday.');
  assert.ok(messages[1].content.includes('[15000] 定价 需要再讨论\n</transcript>'));
  for (const segment of SEGMENTS) assert.ok(!messages[0].content.includes(segment.text));
  assert.equal(formatTranscript([]), '');
});

test('valid responses parse into MeetingNote and normalize unspecified owner/dueDate', () => {
  const note = parseNoteResponse(RESPONSES.valid.complete);
  assert.deepEqual(note, JSON.parse(RESPONSES.valid.complete));
  assert.equal(note.actionItems[1].dueDate, UNSPECIFIED);
  assert.deepEqual(parseNoteResponse(RESPONSES.valid.emptyLists).actionItems, []);
  const normalized = parseNoteResponse(RESPONSES.valid.unspecifiedVariants).actionItems[1];
  assert.deepEqual(normalized, {
    task: 'Research competitor pricing',
    owner: UNSPECIFIED,
    dueDate: UNSPECIFIED,
  });
  // 无来源时不补造 timestampMs
  assert.equal('timestampMs' in normalized, false);
});

// invalidResponse 断言固定错误文案，因此错误中不会带出模型输出或转写正文
test('invalid JSON, missing fields and wrong types are rejected with a fixed safe error', () => {
  for (const [name, content] of Object.entries(RESPONSES.invalid)) {
    assert.throws(() => parseNoteResponse(content), invalidResponse, name);
  }
  for (const content of [undefined, null, 42, { summary: 'object' }, '']) {
    assert.throws(() => parseNoteResponse(content), invalidResponse);
  }
});

test('mock DeepSeek round trip: request uses the prompt contract and the reply validates', async (t) => {
  const server = startServer(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const messages = buildNoteMessages(SEGMENTS);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      response_format: NOTE_RESPONSE_FORMAT,
    }),
  });
  const body = await response.json();
  const note = parseNoteResponse(body.choices[0].message.content);
  assert.ok(note.summary.length > 0);
  assert.deepEqual(server.getRequests()[0].messages, messages);
});

test('rejected model output never reaches note_versions and keeps the previous edit', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'turnnote-note-prompt-')));
  const audioDirectory = join(directory, 'audio');
  mkdirSync(audioDirectory);
  const store = new MeetingStore(join(directory, 'turnnote.db'), audioDirectory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const meeting = store.createCaptured('Planning', join(audioDirectory, 'recording.wav'));
  const transcription = store.beginTranscription(meeting.id);
  store.completeTranscription(transcription.id, SEGMENTS);
  const first = store.beginGeneration(meeting.id);
  assert.equal(
    store.completeGeneration(first.id, parseNoteResponse(RESPONSES.valid.complete)),
    true,
  );
  store.saveEdit(meeting.id, { ...NOTE_EXAMPLE, summary: 'User edit' }, 1);

  const retry = store.beginGeneration(meeting.id);
  // 调用方：校验失败直接以错误码结束 job，不调用 completeGeneration
  try {
    store.completeGeneration(retry.id, parseNoteResponse(RESPONSES.invalid.nullOwner));
    assert.fail('invalid output must not be committed');
  } catch (error) {
    assert.ok(invalidResponse(error));
    store.failJob(retry.id, error.code);
  }
  const latest = store.getLatestNote(meeting.id);
  assert.equal(latest.version, 2);
  assert.equal(latest.note.summary, 'User edit');
  assert.equal(store.get(meeting.id).lastError.code, 'DEEPSEEK_INVALID_RESPONSE');
  assert.deepEqual(store.getSegments(meeting.id), SEGMENTS);
});
