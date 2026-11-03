export function captureEnvironment(
  t,
  { systemDenied = false, micDenied = false, writeFailed = false, duringModule, duringMic } = {},
) {
  const calls = [];
  const mediaCalls = [];
  const tracks = [];
  function stream(video = false) {
    const audio = {
      kind: 'audio',
      stopped: false,
      readyState: 'live',
      listeners: new Set(),
      stop() {
        this.stopped = true;
        this.readyState = 'ended';
      },
      end() {
        this.readyState = 'ended';
        for (const listener of this.listeners) listener();
      },
      addEventListener(type, listener) {
        this.listeners.add(listener);
      },
      removeEventListener(type, listener) {
        this.listeners.delete(listener);
      },
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
    audioWorklet = {
      addModule: async () => {
        await duringModule?.(tracks);
      },
    };
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
      if (this.state === 'closed') throw new DOMException('closed', 'InvalidStateError');
      this.state = 'closed';
      calls.push('close-context');
    }
  }
  const worklets = [];
  class Worklet {
    constructor() {
      worklets.push(this);
    }
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
      userAgent: 'Turnnote test',
      mediaDevices: {
        async enumerateDevices() {
          return [{ deviceId: 'usb-mic', label: 'USB Mic', kind: 'audioinput' }];
        },
        addEventListener() {},
        removeEventListener() {},
        async getDisplayMedia() {
          mediaCalls.push(['system']);
          if (systemDenied) throw new DOMException('denied', 'NotAllowedError');
          return stream(true);
        },
        async getUserMedia(constraints) {
          mediaCalls.push(['microphone', constraints]);
          await duringMic?.(tracks);
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
  return { api, calls, mediaCalls, tracks, context: () => contexts[0], worklet: () => worklets[0] };
}
