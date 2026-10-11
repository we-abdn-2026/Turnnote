import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCapture } from '../out/tests/runtime.mjs';

function environment(t, { systemDenied = false, micDenied = false, writeFailed = false } = {}) {
  const calls = [];
  const tracks = [];
  function stream(video = false) {
    const audio = {
      kind: 'audio',
      stopped: false,
      stop() {
        this.stopped = true;
      },
      addEventListener() {},
    };
    const screen = {
      kind: 'video',
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    const items = video ? [audio, screen] : [audio];
    tracks.push(...items);
    return {
      getTracks: () => items,
      getVideoTracks: () => items.filter((track) => track.kind === 'video'),
      getAudioTracks: () => items.filter((track) => track.kind === 'audio'),
      removeTrack(track) {
        items.splice(items.indexOf(track), 1);
      },
    };
  }
  const contexts = [];
  class Context {
    state = 'suspended';
    destination = {};
    audioWorklet = { addModule: async () => {} };
    constructor() {
      contexts.push(this);
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    async resume() {
      this.state = 'running';
    }
    async close() {
      this.state = 'closed';
      calls.push('close-context');
    }
  }
  class Worklet {
    port = {
      onmessage: undefined,
      close() {},
      postMessage: () => {
        this.port.onmessage({ data: { chunk: new Int16Array([11, 22, 33]) } });
        this.port.onmessage({ data: { flushed: true } });
      },
    };
    connect() {}
    disconnect() {}
  }
  const replacements = {
    navigator: {
      mediaDevices: {
        async getDisplayMedia() {
          if (systemDenied) throw new DOMException('denied', 'NotAllowedError');
          return stream(true);
        },
        async getUserMedia() {
          if (micDenied) throw new DOMException('denied', 'NotAllowedError');
          return stream();
        },
      },
    },
    AudioContext: Context,
    AudioWorkletNode: Worklet,
  };
  for (const [key, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  const api = {
    loopback: {
      async enable() {
        calls.push('enable');
      },
      async disable() {
        calls.push('disable');
      },
    },
    recording: {
      async start() {
        calls.push('start');
        return { ok: true, value: { activeJobId: 'job' } };
      },
      async appendChunk(id, job, chunk) {
        calls.push(['chunk', id, job, [...chunk]]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return writeFailed
          ? { ok: false, error: { code: 'WRITE_FAILED' } }
          : { ok: true, value: null };
      },
      async stop() {
        calls.push('stop');
        return { ok: true, value: { status: 'captured' } };
      },
      async cancel() {
        calls.push('cancel');
        return { ok: true, value: { status: 'created' } };
      },
      async fail(id, job, code) {
        calls.push(['fail', code]);
        return { ok: true, value: { status: 'failed' } };
      },
    },
  };
  return { api, calls, tracks, context: () => contexts[0] };
}
const options = { meetingId: 'meeting', microphoneDeviceId: 'default', includeSystemAudio: true };

test('capture stop flushes the final partial PCM block before Main stop and closes all resources', async (t) => {
  const env = environment(t);
  const session = await startCapture(options, env.api);
  await Promise.all([session.stop(), session.stop()]);
  const chunk = env.calls.findIndex((call) => Array.isArray(call) && call[0] === 'chunk');
  assert.deepEqual(env.calls[chunk], ['chunk', 'meeting', 'job', [11, 22, 33]]);
  assert.ok(chunk < env.calls.indexOf('stop'));
  assert.equal(env.calls.filter((call) => call === 'stop').length, 1);
  assert.equal(env.context().state, 'closed');
  assert.ok(env.tracks.every((track) => track.stopped));
});

test('system permission denial disables loopback, warns, and explicitly falls back to microphone', async (t) => {
  const env = environment(t, { systemDenied: true });
  const warnings = [];
  const session = await startCapture(
    { ...options, onWarning: (warning) => warnings.push(warning) },
    env.api,
  );
  assert.equal(warnings.length, 1);
  assert.deepEqual(env.calls.slice(0, 3), ['start', 'enable', 'disable']);
  await session.cancel();
  assert.ok(env.calls.includes('cancel'));
  assert.ok(env.tracks.every((track) => track.stopped));
});

test('microphone permission denial releases previously acquired system stream and reports failure', async (t) => {
  const env = environment(t, { micDenied: true });
  await assert.rejects(startCapture(options, env.api), { code: 'PERMISSION_DENIED' });
  assert.ok(env.tracks.every((track) => track.stopped));
  assert.deepEqual(env.calls.at(-1), ['fail', 'PERMISSION_DENIED']);
  assert.ok(!env.calls.includes('stop'));
});

test('failed final chunk reports WRITE_FAILED and cannot claim captured', async (t) => {
  const env = environment(t, { writeFailed: true });
  const session = await startCapture(options, env.api);
  await assert.rejects(session.stop(), { code: 'WRITE_FAILED' });
  assert.ok(
    env.calls.some(
      (call) => Array.isArray(call) && call[0] === 'fail' && call[1] === 'WRITE_FAILED',
    ),
  );
  assert.ok(!env.calls.includes('stop'));
  assert.ok(env.tracks.every((track) => track.stopped));
});
