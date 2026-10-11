// ASR sidecar 生命周期：按任务启动、ping 握手、超时、崩溃和协议错误处理。
// 协议见 docs/sidecar-protocol.md。本模块不写数据库，只在收到 done 后一次性返回全部片段，
// 由调用方（会话编排）负责提交片段、job 和会议状态。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ErrorCode, TranscriptSegment, TranscriptionLanguage } from '@shared/contracts';

export const PING_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 120_000;
/** 正常结束后等待进程自行退出的时间，超时强杀 */
const EXIT_GRACE_MS = 3_000;
const STDERR_TAIL_BYTES = 4_096;

export type SidecarErrorCode = Extract<
  ErrorCode,
  | 'SIDECAR_START_FAILED'
  | 'SIDECAR_TIMEOUT'
  | 'SIDECAR_CRASHED'
  | 'SIDECAR_PROTOCOL_ERROR'
  | 'AUDIO_NOT_FOUND'
  | 'AUDIO_DECODE_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'TRANSCRIBE_FAILED'
  | 'INTERRUPTED'
>;

const MESSAGES: Record<SidecarErrorCode, string> = {
  SIDECAR_START_FAILED: 'The transcription engine failed to start.',
  SIDECAR_TIMEOUT: 'Transcription stopped responding.',
  SIDECAR_CRASHED: 'The transcription engine exited unexpectedly.',
  SIDECAR_PROTOCOL_ERROR: 'The transcription engine returned an invalid response.',
  AUDIO_NOT_FOUND: 'The audio file could not be found.',
  AUDIO_DECODE_FAILED: 'The audio file could not be decoded.',
  MODEL_LOAD_FAILED: 'The transcription model could not be loaded.',
  TRANSCRIBE_FAILED: 'Transcription failed.',
  INTERRUPTED: 'Transcription was cancelled.',
};

/** sidecar 自身返回的错误码到 contracts 错误码；请求类错误说明 Main 与 sidecar 协议不一致 */
const SIDECAR_CODES: Record<string, SidecarErrorCode> = {
  AUDIO_NOT_FOUND: 'AUDIO_NOT_FOUND',
  AUDIO_DECODE_FAILED: 'AUDIO_DECODE_FAILED',
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
  TRANSCRIBE_FAILED: 'TRANSCRIBE_FAILED',
  NOT_IMPLEMENTED: 'TRANSCRIBE_FAILED',
  INVALID_REQUEST: 'SIDECAR_PROTOCOL_ERROR',
  UNKNOWN_REQUEST: 'SIDECAR_PROTOCOL_ERROR',
  INVALID_JSON: 'SIDECAR_PROTOCOL_ERROR',
};

export class SidecarError extends Error {
  readonly code: SidecarErrorCode;
  /** 仅用于诊断日志，可能包含路径，不得展示给用户 */
  readonly stderrTail: string;

  constructor(code: SidecarErrorCode, stderrTail = '') {
    super(MESSAGES[code]);
    this.name = 'SidecarError';
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

export interface SidecarCommand {
  command: string;
  args: string[];
}

/** TURNNOTE_ASR_FAKE=1 时追加 --fake，不加载模型 */
export function withFakeFlag(
  base: SidecarCommand,
  env: NodeJS.ProcessEnv = process.env,
): SidecarCommand {
  return env.TURNNOTE_ASR_FAKE === '1' ? { ...base, args: [...base.args, '--fake'] } : base;
}

export interface TranscribeOptions {
  sidecar: SidecarCommand;
  audioPath: string;
  language: TranscriptionLanguage;
  modelPath: string;
  /** 用户取消：直接杀进程，不发送取消消息 */
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  pingTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface TranscribeResult {
  segments: TranscriptSegment[];
  detectedLanguage: string;
  durationMs: number;
}

type Message = Record<string, unknown>;

const isInt = (value: unknown): value is number => Number.isInteger(value);

function isSegment(message: Message): boolean {
  return (
    isInt(message.startMs) &&
    isInt(message.endMs) &&
    (message.startMs as number) >= 0 &&
    (message.endMs as number) >= (message.startMs as number) &&
    typeof message.text === 'string'
  );
}

/**
 * 运行一次转写任务。进程退出后才 settle，保证返回时子进程已释放。
 * 成功：收到 done 且片段数一致；失败：抛出 SidecarError，不返回部分片段。
 */
export function transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
  const pingTimeoutMs = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new SidecarError('INTERRUPTED'));
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.sidecar.command, options.sidecar.args, {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch {
      reject(new SidecarError('SIDECAR_START_FAILED'));
      return;
    }

    const pingId = randomUUID();
    const jobId = randomUUID();
    const segments: TranscriptSegment[] = [];
    let phase: 'starting' | 'transcribing' | 'finishing' = 'starting';
    let outcome:
      { ok: true; value: TranscribeResult } | { ok: false; code: SidecarErrorCode } | null = null;
    let stderrTail = '';
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const send = (payload: Message): void => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(payload) + '\n');
    };

    const arm = (ms: number, code: SidecarErrorCode): void => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(code), ms);
    };

    // 记录结果并让进程退出；真正的 resolve/reject 在 close 事件中完成
    const finish = (result: NonNullable<typeof outcome>): void => {
      if (outcome) return;
      outcome = result;
      phase = 'finishing';
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (result.ok) {
        send({ id: randomUUID(), type: 'shutdown' });
        child.stdin.end();
        graceTimer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS);
      } else {
        child.kill('SIGKILL');
      }
    };

    const fail = (code: SidecarErrorCode): void => finish({ ok: false, code });

    function onAbort(): void {
      fail('INTERRUPTED');
    }

    const handle = (message: Message): void => {
      if (phase === 'starting') {
        if (message.id === pingId && message.type === 'pong') {
          phase = 'transcribing';
          send({
            id: jobId,
            type: 'transcribe',
            audioPath: options.audioPath,
            language: options.language,
            modelPath: options.modelPath,
          });
          arm(idleTimeoutMs, 'SIDECAR_TIMEOUT');
        } else {
          fail('SIDECAR_PROTOCOL_ERROR');
        }
        return;
      }

      // 迟到或重复的 pong、其他请求 id 的响应：忽略
      if (message.id !== jobId) return;
      arm(idleTimeoutMs, 'SIDECAR_TIMEOUT');

      switch (message.type) {
        case 'progress':
          if (!isInt(message.percent) || message.percent < 0 || message.percent > 100) {
            fail('SIDECAR_PROTOCOL_ERROR');
            return;
          }
          options.onProgress?.(message.percent);
          return;
        case 'segment':
          if (!isSegment(message)) {
            fail('SIDECAR_PROTOCOL_ERROR');
            return;
          }
          segments.push({
            startMs: message.startMs as number,
            endMs: message.endMs as number,
            text: message.text as string,
          });
          return;
        case 'done':
          if (
            message.segmentCount !== segments.length ||
            !isInt(message.durationMs) ||
            typeof message.detectedLanguage !== 'string'
          ) {
            fail('SIDECAR_PROTOCOL_ERROR');
            return;
          }
          finish({
            ok: true,
            value: {
              segments,
              detectedLanguage: message.detectedLanguage,
              durationMs: message.durationMs,
            },
          });
          return;
        case 'error':
          fail(SIDECAR_CODES[String(message.code)] ?? 'SIDECAR_PROTOCOL_ERROR');
          return;
        default:
          fail('SIDECAR_PROTOCOL_ERROR');
      }
    };

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (outcome || !line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail('SIDECAR_PROTOCOL_ERROR');
        return;
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        fail('SIDECAR_PROTOCOL_ERROR');
        return;
      }
      handle(message as Message);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // 进程已退出时写 stdin 会 EPIPE，结果以 close 事件为准
    child.stdin.on('error', () => {});

    child.on('error', () => {
      // spawn 失败（命令不存在等）；之后仍会触发 close
      if (!outcome) fail(phase === 'starting' ? 'SIDECAR_START_FAILED' : 'SIDECAR_CRASHED');
    });

    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      // 未得出结果就退出，即使退出码为 0 也视为失败；握手前退出算启动失败
      const result = outcome ?? {
        ok: false as const,
        code:
          phase === 'starting' ? ('SIDECAR_START_FAILED' as const) : ('SIDECAR_CRASHED' as const),
      };
      if (result.ok) resolve(result.value);
      else reject(new SidecarError(result.code, stderrTail));
    });

    options.signal?.addEventListener('abort', onAbort, { once: true });
    arm(pingTimeoutMs, 'SIDECAR_START_FAILED');
    send({ id: pingId, type: 'ping' });
  });
}
