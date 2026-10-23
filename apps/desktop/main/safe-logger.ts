import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { invokeChannels, type ErrorCode } from '@shared/contracts';
import { errorMessages } from '@shared/result';

export type LogSource = 'main' | 'ipc' | 'sidecar' | 'deepseek';
export type LogLevel = 'info' | 'warn' | 'error';
export type LogEvent =
  | 'started'
  | 'startup_failed'
  | 'recording_interrupt_failed'
  | 'request_failed'
  | 'transcription_failed';

export interface IpcFailure {
  channel: string;
  code: ErrorCode;
  cause?: unknown;
}

const MAX_LOG_BYTES = 1_000_000;
const EVENTS = new Set<LogEvent>([
  'started',
  'startup_failed',
  'recording_interrupt_failed',
  'request_failed',
  'transcription_failed',
]);
const CODES = new Set<ErrorCode>(Object.keys(errorMessages) as ErrorCode[]);
const OPERATIONS = new Set<string>(
  Object.values(invokeChannels).flatMap((methods) => Object.values(methods)),
);
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AggregateError',
  'DOMException',
  'TurnnoteError',
  'SidecarError',
]);
const SIDECAR_STAGES = new Set(['import', 'decode', 'model load', 'transcribe']);

interface SafeLogEvent {
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  event: string;
  code?: ErrorCode;
  operation?: string;
  exceptionType?: string;
  diagnosticStage?: string;
}

function exceptionType(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (!(error instanceof Error)) return 'NonError';
  try {
    return ERROR_NAMES.has(error.name) ? error.name : 'UnknownError';
  } catch {
    return 'UnknownError';
  }
}

function sidecarStage(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\[asr-worker\] ([a-z ]+) failed:/.exec(line.trim());
    if (match && SIDECAR_STAGES.has(match[1])) return match[1];
  }
  return undefined;
}

export function safeLogPath(userDataDirectory: string): string {
  return join(userDataDirectory, 'logs', 'turnnote.log');
}

export class SafeLogger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  info(source: LogSource, event: LogEvent): void {
    this.write({ source, event, level: 'info' });
  }

  error(source: LogSource, event: LogEvent, code: ErrorCode, error?: unknown): void {
    this.write({ source, event, code, level: 'error', exceptionType: exceptionType(error) });
  }

  ipcFailure(failure: IpcFailure): void {
    this.write({
      source: 'ipc',
      event: 'request_failed',
      code: failure.code,
      level: failure.code === 'INTERNAL' ? 'error' : 'warn',
      operation: OPERATIONS.has(failure.channel) ? failure.channel : 'unknown',
      exceptionType: exceptionType(failure.cause),
    });
  }

  sidecarFailure(code: ErrorCode, stderr: string, error?: unknown): void {
    this.write({
      source: 'sidecar',
      event: 'transcription_failed',
      code,
      level: 'error',
      exceptionType: exceptionType(error),
      diagnosticStage: sidecarStage(stderr),
    });
  }

  private write(input: Omit<SafeLogEvent, 'timestamp'>): void {
    const entry: SafeLogEvent = {
      timestamp: new Date().toISOString(),
      level: input.level,
      source: input.source,
      event: EVENTS.has(input.event as LogEvent) ? input.event : 'unknown',
      ...(input.code ? { code: CODES.has(input.code) ? input.code : 'INTERNAL' } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.exceptionType ? { exceptionType: input.exceptionType } : {}),
      ...(input.diagnosticStage ? { diagnosticStage: input.diagnosticStage } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      const directory = dirname(this.path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        chmodSync(directory, 0o700);
      } catch {
        // Windows does not implement POSIX directory modes.
      }
      let currentBytes = 0;
      try {
        currentBytes = statSync(this.path).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
      if (currentBytes + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        const previous = `${this.path}.1`;
        try {
          unlinkSync(previous);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
        }
        try {
          renameSync(this.path, previous);
        } catch {
          return;
        }
      }
      appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch {
      // Diagnostics must never interrupt user work or fall back to an unsafe console dump.
    }
  }
}
