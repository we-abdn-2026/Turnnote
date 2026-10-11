import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pythonExecutable } from './support/python.mjs';

const WORKER = 'services/asr-worker/worker.py';
// 任意存在的文件即可通过 AUDIO_NOT_FOUND 检查；fake 模式不解码音频
const EXISTING_FILE = 'package.json';

function runWithStderr(requests, { args = [], env } = {}) {
  const result = spawnSync(pythonExecutable(), [WORKER, ...args], {
    input: requests.map((request) => JSON.stringify(request) + '\n').join(''),
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { responses, stderr: result.stderr };
}

function run(requests, args = []) {
  return runWithStderr(requests, { args }).responses;
}

function transcribeRequest(overrides = {}) {
  return {
    id: 't-1',
    type: 'transcribe',
    audioPath: EXISTING_FILE,
    language: 'en',
    modelPath: 'models/small',
    ...overrides,
  };
}

test('answers ping', () => {
  assert.deepEqual(run([{ id: 'p-1', type: 'ping' }]), [{ id: 'p-1', type: 'pong', status: 'ok' }]);
});

test('reports invalid JSON and keeps running', () => {
  const result = spawnSync(pythonExecutable(), [WORKER], {
    input: 'not json\n{"id":"p-2","type":"ping"}\n',
    encoding: 'utf8',
  });
  const [first, second] = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(first.code, 'INVALID_JSON');
  assert.equal(second.type, 'pong');
});

test('rejects unknown request type', () => {
  const [response] = run([{ id: 'u-1', type: 'unknown' }]);
  assert.equal(response.code, 'UNKNOWN_REQUEST');
});

test('rejects transcribe with missing fields', () => {
  const [response] = run([{ id: 't-0', type: 'transcribe' }]);
  assert.equal(response.id, 't-0');
  assert.equal(response.code, 'INVALID_REQUEST');
});

test('rejects unsupported language', () => {
  const [response] = run([transcribeRequest({ language: 'fr' })]);
  assert.equal(response.code, 'INVALID_REQUEST');
});

test('reports missing audio file', () => {
  const [response] = run([transcribeRequest({ audioPath: 'does/not/exist.wav' })]);
  assert.equal(response.code, 'AUDIO_NOT_FOUND');
});

// 以下真实转写路径需要 requirements.txt 中的 faster-whisper（CI 已安装）
const hasFasterWhisper =
  spawnSync(pythonExecutable(), ['-c', 'import faster_whisper']).status === 0;
const needsFasterWhisper = { skip: !hasFasterWhisper && 'faster-whisper not installed' };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'turnnote-asr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 16kHz 单声道 16-bit PCM 静音
function silentWav(path, seconds = 1) {
  const data = 16000 * 2 * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(data)]));
  return path;
}

test('rejects unsupported audio extension', () => {
  const [response] = run([transcribeRequest()]);
  assert.equal(response.code, 'AUDIO_DECODE_FAILED');
});

test('reports undecodable audio', needsFasterWhisper, (t) => {
  const audioPath = join(tempDir(t), 'corrupt.wav');
  writeFileSync(audioPath, 'this is not audio');
  const responses = run([transcribeRequest({ audioPath })]);
  assert.equal(responses.at(-1).code, 'AUDIO_DECODE_FAILED');
});

test('reports missing model directory without downloading', needsFasterWhisper, (t) => {
  const audioPath = silentWav(join(tempDir(t), 'silence.wav'));
  // 裸模型名会让 faster-whisper 联网下载，sidecar 必须拒绝
  const responses = run([transcribeRequest({ audioPath, modelPath: 'small' })]);
  assert.equal(responses.at(-1).code, 'MODEL_LOAD_FAILED');
});

// 模型目录：文件齐全但内容无效，走到 WhisperModel 真正加载失败的分支
function brokenModelDir(dir, files = ['model.bin', 'config.json', 'tokenizer.json']) {
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(join(dir, name), 'not a model');
  return dir;
}

// sitecustomize 在 worker 启动时加载：拦截 Python socket 和 Tokenizer.from_pretrained，
// 任何联网尝试都会在 stderr 留下 NETWORK_ATTEMPT
function networkGuard(dir, { stubWeights = false } = {}) {
  writeFileSync(
    join(dir, 'sitecustomize.py'),
    `import socket, sys
def _block(*args, **kwargs):
    sys.stderr.write("NETWORK_ATTEMPT\\n")
    raise OSError("network blocked by test")
socket.socket.connect = _block
socket.create_connection = _block
socket.getaddrinfo = _block
try:
    import tokenizers
    tokenizers.Tokenizer.from_pretrained = staticmethod(_block)
except ImportError:
    pass
${stubWeights ? STUB_CTRANSLATE2 : ''}
sys.stderr.write("NETGUARD_ACTIVE\\n")
`,
  );
  return { PYTHONPATH: dir };
}

// 替换 CTranslate2 权重加载，让占位模型也能走到 faster-whisper 的 tokenizer 回退分支
// （与审查复现方式一致）；不替换时占位权重会先在 CTranslate2 处失败
const STUB_CTRANSLATE2 = `
import ctranslate2
class _StubWhisper:
    is_multilingual = True
    def __init__(self, *args, **kwargs):
        pass
ctranslate2.models.Whisper = _StubWhisper
`;

test('reports unloadable model', needsFasterWhisper, (t) => {
  const dir = tempDir(t);
  const audioPath = silentWav(join(dir, 'silence.wav'));
  const modelPath = brokenModelDir(join(dir, 'model'));
  const responses = run([transcribeRequest({ audioPath, modelPath })]);
  assert.equal(responses.at(-1).code, 'MODEL_LOAD_FAILED');
});

// 审查 #62 P1：缺 tokenizer.json 时 faster-whisper 会调用 Tokenizer.from_pretrained 联网
test('missing tokenizer.json fails without any network attempt', needsFasterWhisper, (t) => {
  const dir = tempDir(t);
  const audioPath = silentWav(join(dir, 'silence.wav'));
  const modelPath = brokenModelDir(join(dir, 'model'), ['model.bin', 'config.json']);
  const { responses, stderr } = runWithStderr([transcribeRequest({ audioPath, modelPath })], {
    env: networkGuard(dir, { stubWeights: true }),
  });
  assert.match(stderr, /NETGUARD_ACTIVE/, 'network guard must be loaded');
  assert.equal(responses.at(-1).code, 'MODEL_LOAD_FAILED');
  assert.doesNotMatch(stderr, /NETWORK_ATTEMPT/);
});

// 真实模型只缺 tokenizer.json：其余文件可加载，能真正走到 faster-whisper 的联网回退分支
test(
  'real model without tokenizer.json fails without any network attempt',
  { skip: !process.env.TURNNOTE_ASR_MODEL && 'set TURNNOTE_ASR_MODEL' },
  (t) => {
    const dir = tempDir(t);
    const audioPath = silentWav(join(dir, 'silence.wav'));
    const modelPath = join(dir, 'model');
    mkdirSync(modelPath);
    for (const name of readdirSync(process.env.TURNNOTE_ASR_MODEL)) {
      if (name !== 'tokenizer.json') {
        symlinkSync(join(process.env.TURNNOTE_ASR_MODEL, name), join(modelPath, name));
      }
    }
    const { responses, stderr } = runWithStderr([transcribeRequest({ audioPath, modelPath })], {
      env: networkGuard(dir),
    });
    assert.match(stderr, /NETGUARD_ACTIVE/);
    assert.equal(responses.at(-1).code, 'MODEL_LOAD_FAILED');
    assert.doesNotMatch(stderr, /NETWORK_ATTEMPT/);
  },
);

// 审查 #62 P2：PyAV 异常原文含完整音频路径，诊断不得输出
test('decode failure diagnostics do not leak the audio path', needsFasterWhisper, (t) => {
  const dir = join(tempDir(t), 'private-folder');
  mkdirSync(dir);
  const audioPath = join(dir, 'sensitive-meeting-title.wav');
  writeFileSync(audioPath, 'not audio');
  const { responses, stderr } = runWithStderr([transcribeRequest({ audioPath })]);
  assert.equal(responses.at(-1).code, 'AUDIO_DECODE_FAILED');
  assert.match(stderr, /decode failed/, 'diagnostic line should still be written');
  assert.doesNotMatch(stderr, /sensitive-meeting-title|private-folder/);
});

test('model load failure diagnostics do not leak the model path', needsFasterWhisper, (t) => {
  const dir = tempDir(t);
  const audioPath = silentWav(join(dir, 'silence.wav'));
  const modelPath = brokenModelDir(join(dir, 'sensitive-model-dir'));
  const { responses, stderr } = runWithStderr([transcribeRequest({ audioPath, modelPath })]);
  assert.equal(responses.at(-1).code, 'MODEL_LOAD_FAILED');
  assert.doesNotMatch(stderr, /sensitive-model-dir/);
});

// 真实模型验收：TURNNOTE_ASR_MODEL=<模型目录> TURNNOTE_ASR_AUDIO=<音频> npm test
const realModel = process.env.TURNNOTE_ASR_MODEL;
const realAudio = process.env.TURNNOTE_ASR_AUDIO;
test(
  'real model transcribes audio per protocol',
  { skip: !(realModel && realAudio) && 'set TURNNOTE_ASR_MODEL and TURNNOTE_ASR_AUDIO' },
  () => {
    const responses = run([
      transcribeRequest({ audioPath: realAudio, modelPath: realModel, language: 'auto' }),
    ]);
    assert.ok(responses.every((response) => response.id === 't-1'));
    const done = responses.at(-1);
    assert.equal(done.type, 'done', JSON.stringify(done));

    const segments = responses.filter((response) => response.type === 'segment');
    assert.ok(segments.length > 0);
    assert.equal(done.segmentCount, segments.length);
    for (const segment of segments) {
      assert.ok(Number.isInteger(segment.startMs) && Number.isInteger(segment.endMs));
      assert.ok(segment.startMs <= segment.endMs && segment.endMs <= done.durationMs);
      assert.ok(segment.text.length > 0);
    }

    const percents = responses.filter((r) => r.type === 'progress').map((r) => r.percent);
    assert.deepEqual(
      percents,
      [...percents].sort((a, b) => a - b),
    );
    assert.equal(percents.at(-1), 100);
  },
);

test('fake mode streams progress, segments and done', () => {
  const responses = run([transcribeRequest({ language: 'auto' })], ['--fake']);
  const types = responses.map((response) => response.type);
  assert.deepEqual(types, ['progress', 'segment', 'segment', 'segment', 'progress', 'done']);
  assert.ok(responses.every((response) => response.id === 't-1'));

  const segments = responses.filter((response) => response.type === 'segment');
  const done = responses.at(-1);
  assert.equal(done.segmentCount, segments.length);
  assert.equal(done.detectedLanguage, 'en');
  assert.equal(done.durationMs, segments.at(-1).endMs);
  for (const segment of segments) assert.ok(segment.endMs > segment.startMs);
});

test('shutdown stops processing later requests', () => {
  const responses = run([
    { id: 's-1', type: 'shutdown' },
    { id: 'p-3', type: 'ping' },
  ]);
  assert.deepEqual(responses, []);
});
