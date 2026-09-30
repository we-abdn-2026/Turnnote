import { ipcMain } from 'electron';
import {
  invokeChannels,
  type ErrorCode,
  type Result,
  type TurnnoteInvokeApi,
} from '@shared/contracts';

/** 未提供的方法自动返回 NOT_IMPLEMENTED */
export type IpcHandlers = {
  [N in keyof TurnnoteInvokeApi]?: Partial<TurnnoteInvokeApi[N]>;
};

type AnyHandler = (...args: unknown[]) => Promise<Result<unknown>>;

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export function registerIpc(handlers: IpcHandlers): void {
  for (const [namespace, methods] of Object.entries(invokeChannels)) {
    const implemented = handlers[namespace as keyof IpcHandlers] as
      Record<string, AnyHandler | undefined> | undefined;

    for (const [method, channel] of Object.entries(methods)) {
      const handler = implemented?.[method];
      ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
        if (!handler) return fail('NOT_IMPLEMENTED', 'This feature is not available yet.');
        try {
          return await handler(...args);
        } catch (error) {
          console.error(`[ipc] ${channel} failed`, error);
          return fail('INTERNAL', 'Something went wrong. Please try again.');
        }
      });
    }
  }
}
