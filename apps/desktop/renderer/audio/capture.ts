import type { CaptureErrorCode, TurnnoteApi } from '@shared/contracts';
import { TurnnoteError } from '@shared/result';
import workletUrl from './pcm-worklet.ts?worker&url';

export interface CaptureOptions {
  meetingId: string;
  microphoneDeviceId: string | null;
  includeSystemAudio: boolean;
  onWarning?: (message: string) => void;
  onError?: (error: TurnnoteError) => void;
}
export interface CaptureSession {
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

function captureCode(error: unknown): CaptureErrorCode {
  if (
    error instanceof TurnnoteError &&
    ['PERMISSION_DENIED', 'DEVICE_NOT_FOUND', 'CAPTURE_FAILED', 'WRITE_FAILED'].includes(error.code)
  )
    return error.code as CaptureErrorCode;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'PERMISSION_DENIED';
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
      return 'DEVICE_NOT_FOUND';
  }
  return 'CAPTURE_FAILED';
}

let capturing = false;
export async function startCapture(
  options: CaptureOptions,
  api: TurnnoteApi = window.turnnote,
): Promise<CaptureSession> {
  if (capturing) throw new TurnnoteError('INVALID_STATE');
  if (options.microphoneDeviceId === null && !options.includeSystemAudio)
    throw new TurnnoteError('INVALID_INPUT');
  capturing = true;
  const streams: MediaStream[] = [];
  let context: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let jobId: string | undefined;
  let finished = false;
  let pending: Promise<void> = Promise.resolve();
  let queued = 0;
  let writeError: CaptureErrorCode | undefined;
  let failedTask: Promise<void> | undefined;
  let failureCode: CaptureErrorCode | undefined;
  async function cleanup() {
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    worklet?.disconnect();
    worklet?.port.close();
    try {
      await context?.close();
    } finally {
      capturing = false;
    }
  }
  function reportFailure(code: CaptureErrorCode): Promise<void> {
    if (failedTask) return failedTask;
    failureCode = code;
    finished = true;
    failedTask = (async () => {
      try {
        await cleanup();
      } catch {
        /* Still notify Main. */
      }
      await pending;
      if (jobId) await api.recording.fail(options.meetingId, jobId, code);
      options.onError?.(new TurnnoteError(code));
    })();
    return failedTask;
  }
  try {
    const started = await api.recording.start(options.meetingId);
    if (!started.ok) throw new TurnnoteError(started.error.code);
    jobId = started.value.activeJobId ?? undefined;
    if (!jobId) throw new TurnnoteError('CAPTURE_FAILED');
    if (options.includeSystemAudio) {
      let system: MediaStream | undefined;
      try {
        await api.loopback.enable();
        try {
          system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } finally {
          await api.loopback.disable();
        }
        for (const track of system.getVideoTracks()) {
          track.stop();
          system.removeTrack(track);
        }
        if (!system.getAudioTracks().length) throw new TurnnoteError('CAPTURE_FAILED');
        streams.push(system);
      } catch (error) {
        system?.getTracks().forEach((track) => track.stop());
        if (options.microphoneDeviceId === null) throw error;
        options.onWarning?.('System audio is unavailable. Recording microphone only.');
      }
    }
    if (options.microphoneDeviceId !== null) {
      streams.push(
        await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: options.microphoneDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        }),
      );
    }
    try {
      context = new AudioContext({ sampleRate: 16000 });
    } catch {
      // Some devices only support their native rate; the Worklet still outputs 16kHz.
      context = new AudioContext();
    }
    await context.audioWorklet.addModule(workletUrl);
    worklet = new AudioWorkletNode(context, 'turnnote-capture', {
      numberOfInputs: streams.length,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    let flushed: (() => void) | undefined;
    worklet.port.onmessage = (event: MessageEvent<{ chunk?: Int16Array; flushed?: boolean }>) => {
      if (event.data.flushed) {
        flushed?.();
        return;
      }
      if (finished || !event.data.chunk) return;
      const chunk = event.data.chunk;
      // Bound memory if disk/IPC cannot keep up; preserve prior chunks and fail visibly.
      if (++queued > 8) {
        void reportFailure('WRITE_FAILED');
        return;
      }
      pending = pending.then(async () => {
        if (writeError) return;
        try {
          const result = await api.recording.appendChunk(options.meetingId, jobId!, chunk);
          if (!result.ok) writeError = captureCode(new TurnnoteError(result.error.code));
        } catch {
          writeError = 'WRITE_FAILED';
        } finally {
          queued--;
        }
      });
      void pending.then(() => {
        if (writeError && !finished) void reportFailure(writeError);
      });
    };
    streams.forEach((stream, i) => {
      context!.createMediaStreamSource(stream).connect(worklet!, 0, i);
      stream.getAudioTracks().forEach((track) =>
        track.addEventListener('ended', () => {
          if (!finished) void reportFailure('CAPTURE_FAILED');
        }),
      );
    });
    worklet.onprocessorerror = () => {
      if (!finished) void reportFailure('CAPTURE_FAILED');
    };
    worklet.connect(context.destination);
    await context.resume();
    if (context.state !== 'running') throw new TurnnoteError('CAPTURE_FAILED');
    context.onstatechange = () => {
      if (!finished && context?.state !== 'running') void reportFailure('CAPTURE_FAILED');
    };
    let stopping: Promise<void> | undefined;
    return {
      stop() {
        if (stopping) return stopping;
        stopping = (async () => {
          if (finished) {
            await failedTask;
            if (failureCode) throw new TurnnoteError(failureCode);
            return;
          }
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new TurnnoteError('CAPTURE_FAILED')), 3000);
              flushed = () => {
                clearTimeout(timeout);
                resolve();
              };
              worklet!.port.postMessage('flush');
            });
            await pending;
            if (finished) {
              await failedTask;
              if (failureCode) throw new TurnnoteError(failureCode);
              return;
            }
            if (writeError) throw new TurnnoteError(writeError);
            finished = true;
            await cleanup();
            const result = await api.recording.stop(options.meetingId, jobId!);
            if (!result.ok) throw new TurnnoteError(result.error.code);
          } catch (error) {
            await reportFailure(captureCode(error));
            throw new TurnnoteError(captureCode(error));
          }
        })();
        return stopping;
      },
      async cancel() {
        if (stopping) await stopping;
        else {
          finished = true;
          await cleanup();
          await pending;
          await failedTask;
        }
        const result = await api.recording.cancel(options.meetingId, jobId!);
        if (!result.ok) throw new TurnnoteError(result.error.code);
      },
    };
  } catch (error) {
    if (jobId) await reportFailure(captureCode(error));
    else {
      try {
        await cleanup();
      } catch {
        capturing = false;
      }
    }
    throw error instanceof TurnnoteError ? error : new TurnnoteError(captureCode(error));
  }
}
