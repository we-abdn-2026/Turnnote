import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { SidecarError, transcribe, withFakeFlag } from '../apps/desktop/main/services/sidecar.ts';
import { pythonExecutable } from './support/python.mjs';

const WORKER = 'services/asr-worker/worker.py';
// fake 模式只检查文件存在，不解码音频
const AUDIO = 'package.json';

const base = { audioPath: AUDIO, language: 'en', modelPath: 'models/small' };

// 用 Node 脚本模拟各种 sidecar 行为；onLine(msg, out) 处理每条请求
function stub(body) {
  const script = `
    const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => { const msg = JSON.parse(line); (${body})(msg, out); });
  `;
  return { command: process.execPath, args: ['-e', script] };
}

// 先回 pong，再把 transcribe 交给 onTranscribe
function afterPong(onTranscribe) {
  return stub(`(msg, out) => {
    if (msg.type === 'ping') return out({ id: msg.id, type: 'pong', status: 'ok' });
    if (msg.type === 'transcribe') (${onTranscribe})(msg, out);
    if (msg.type === 'shutdown') process.exit(0);
  }`);
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SidecarError, `expected SidecarError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('fake worker: ping, transcribe, done, then process exits', async () => {
  const progress = [];
  const result = await transcribe({
    ...base,
    sidecar: withFakeFlag(
      { command: pythonExecutable(), args: [WORKER] },
      { TURNNOTE_ASR_FAKE: '1' },
    ),
    onProgress: (percent) => progress.push(percent),
  });
  assert.equal(result.segments.length, 3);
  assert.equal(result.detectedLanguage, 'en');
  assert.equal(result.durationMs, result.segments.at(-1).endMs);
  assert.deepEqual(progress, [0, 100]);
  for (const segment of result.segments) assert.ok(segment.endMs > segment.startMs);
});

test('withFakeFlag only appends --fake when TURNNOTE_ASR_FAKE=1', () => {
  const cmd = { command: 'python3', args: [WORKER] };
  assert.deepEqual(withFakeFlag(cmd, { TURNNOTE_ASR_FAKE: '1' }).args, [WORKER, '--fake']);
  assert.deepEqual(withFakeFlag(cmd, { TURNNOTE_ASR_FAKE: '0' }).args, [WORKER]);
  assert.deepEqual(withFakeFlag(cmd, {}).args, [WORKER]);
});

test('real worker error is mapped to a contracts error code', async () => {
  await rejectsWith(
    transcribe({
      ...base,
      audioPath: 'does/not/exist.wav',
      sidecar: { command: pythonExecutable(), args: [WORKER, '--fake'] },
    }),
    'AUDIO_NOT_FOUND',
  );
});

test('missing executable is SIDECAR_START_FAILED', async () => {
  await rejectsWith(
    transcribe({ ...base, sidecar: { command: 'turnnote-no-such-binary', args: [] } }),
    'SIDECAR_START_FAILED',
  );
});

test('no pong within ping timeout is SIDECAR_START_FAILED', async () => {
  await rejectsWith(
    transcribe({ ...base, sidecar: stub('() => {}'), pingTimeoutMs: 200 }),
    'SIDECAR_START_FAILED',
  );
});

test('exit before pong is SIDECAR_START_FAILED', async () => {
  await rejectsWith(
    transcribe({ ...base, sidecar: stub('() => process.exit(1)') }),
    'SIDECAR_START_FAILED',
  );
});

test('no output during transcription is SIDECAR_TIMEOUT', async () => {
  await rejectsWith(
    transcribe({ ...base, sidecar: afterPong('() => {}'), idleTimeoutMs: 200 }),
    'SIDECAR_TIMEOUT',
  );
});

test('progress resets the idle timer', async () => {
  const sidecar = afterPong(`(msg, out) => {
    let n = 0;
    const tick = setInterval(() => {
      n += 1;
      out({ id: msg.id, type: 'progress', percent: n * 20 });
      if (n === 5) {
        clearInterval(tick);
        out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 0, segmentCount: 0 });
      }
    }, 100);
  }`);
  // 总耗时约 500ms，超过 idle 超时，但每次输出都会重置计时
  const result = await transcribe({ ...base, sidecar, idleTimeoutMs: 300 });
  assert.equal(result.segments.length, 0);
});

test('crash mid-transcription is SIDECAR_CRASHED with stderr tail', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'segment', startMs: 0, endMs: 1000, text: 'partial' });
    process.stderr.write('boom: decoder died');
    process.exit(3);
  }`);
  await assert.rejects(transcribe({ ...base, sidecar }), (error) => {
    assert.equal(error.code, 'SIDECAR_CRASHED');
    assert.match(error.stderrTail, /decoder died/);
    // 用户可见信息不包含 stderr 内容
    assert.doesNotMatch(error.message, /decoder/);
    return true;
  });
});

test('clean exit without done is still SIDECAR_CRASHED', async () => {
  await rejectsWith(
    transcribe({ ...base, sidecar: afterPong('() => process.exit(0)') }),
    'SIDECAR_CRASHED',
  );
});

test('non-JSON stdout line is SIDECAR_PROTOCOL_ERROR', async () => {
  const sidecar = afterPong(`() => process.stdout.write('Loading model...\\n')`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

test('malformed segment is SIDECAR_PROTOCOL_ERROR', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'segment', startMs: 500, endMs: 100, text: 'backwards' });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

test('done with mismatched segmentCount is SIDECAR_PROTOCOL_ERROR', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'segment', startMs: 0, endMs: 1000, text: 'one' });
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 2 });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

test('duplicate pong, foreign ids and output after done are ignored', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: 'stale-ping', type: 'pong', status: 'ok' });
    out({ id: 'other-job', type: 'segment', startMs: 0, endMs: 10, text: 'not mine' });
    out({ id: msg.id, type: 'segment', startMs: 0, endMs: 1000, text: 'mine' });
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 1 });
    out({ id: msg.id, type: 'segment', startMs: 1000, endMs: 2000, text: 'late' });
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 2000, segmentCount: 2 });
  }`);
  const result = await transcribe({ ...base, sidecar });
  assert.deepEqual(result.segments, [{ startMs: 0, endMs: 1000, text: 'mine' }]);
  assert.equal(result.durationMs, 1000);
});

test('sidecar request-level errors are SIDECAR_PROTOCOL_ERROR', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'error', code: 'INVALID_REQUEST', message: 'bad field' });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

// 审查 #61 P1：非字符串 code 曾在 readline 回调里抛 TypeError，宿主进程直接退出
test('error with non-string code is SIDECAR_PROTOCOL_ERROR, not an uncaught throw', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'error', code: { toString: null }, message: 'bad code' });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

// 审查 #61 P1：原型属性名曾命中普通对象的继承属性，得到 function 类型的 code
for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
  test(`error with prototype property name "${code}" is SIDECAR_PROTOCOL_ERROR`, async () => {
    const sidecar = afterPong(`(msg, out) => {
      out({ id: msg.id, type: 'error', code: ${JSON.stringify(code)}, message: 'x' });
    }`);
    await assert.rejects(transcribe({ ...base, sidecar }), (error) => {
      assert.equal(error.code, 'SIDECAR_PROTOCOL_ERROR');
      assert.equal(typeof error.code, 'string');
      assert.ok(error.message.length > 0);
      return true;
    });
  });
}

// 审查 #61 P2：负时长曾作为成功结果返回
test('done with negative durationMs is SIDECAR_PROTOCOL_ERROR', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: -100, segmentCount: 0 });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

test('done with non-integer or unsafe durationMs is SIDECAR_PROTOCOL_ERROR', async () => {
  for (const durationMs of [1.5, '1000', Number.MAX_SAFE_INTEGER + 2]) {
    const sidecar = afterPong(`(msg, out) => {
      out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: ${JSON.stringify(durationMs)}, segmentCount: 0 });
    }`);
    await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
  }
});

test('segment ending after durationMs is SIDECAR_PROTOCOL_ERROR', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'segment', startMs: 0, endMs: 5000, text: 'too long' });
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 1000, segmentCount: 1 });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

test('negative segment timestamps are SIDECAR_PROTOCOL_ERROR', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'segment', startMs: -10, endMs: 100, text: 'x' });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'SIDECAR_PROTOCOL_ERROR');
});

test('jobId is used as the transcribe request id', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'segment', startMs: 0, endMs: 10, text: msg.id });
    out({ id: msg.id, type: 'done', detectedLanguage: 'en', durationMs: 10, segmentCount: 1 });
  }`);
  const result = await transcribe({ ...base, sidecar, jobId: 'job-123' });
  assert.equal(result.segments[0].text, 'job-123');
});

test('model load failure passes through', async () => {
  const sidecar = afterPong(`(msg, out) => {
    out({ id: msg.id, type: 'error', code: 'MODEL_LOAD_FAILED', message: 'no model' });
  }`);
  await rejectsWith(transcribe({ ...base, sidecar }), 'MODEL_LOAD_FAILED');
});

test('user cancel kills the process and is INTERRUPTED', async () => {
  const controller = new AbortController();
  const sidecar = afterPong(`(msg, out) => out({ id: msg.id, type: 'progress', percent: 10 })`);
  const run = transcribe({
    ...base,
    sidecar,
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  await rejectsWith(run, 'INTERRUPTED');
});

test('already-aborted signal does not spawn', async () => {
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(
    transcribe({ ...base, sidecar: stub('() => {}'), signal: controller.signal }),
    'INTERRUPTED',
  );
});

test('failures leave the audio file in place', async () => {
  await rejectsWith(
    transcribe({ ...base, sidecar: afterPong('() => process.exit(1)') }),
    'SIDECAR_CRASHED',
  );
  assert.ok(existsSync(AUDIO));
});
