import { invokeChannels, type Result, type TurnnoteInvokeApi } from './contracts';
import { invokeSchemas } from './schemas';
import { fail, TurnnoteError } from './result';
import type { ZodType } from 'zod';

export type InvokeHandlers = { [N in keyof TurnnoteInvokeApi]?: Partial<TurnnoteInvokeApi[N]> };
type AnyHandler = (...args: unknown[]) => Promise<Result<unknown>>;

export function createDispatcher(handlers: InvokeHandlers) {
  const routes: Map<string, { handler: AnyHandler | undefined; schema: ZodType }> = new Map(
    Object.entries(invokeChannels).flatMap(([namespace, methods]) =>
      Object.entries(methods).map(([method, channel]) => {
        const handler = (
          handlers[namespace as keyof InvokeHandlers] as Record<string, AnyHandler> | undefined
        )?.[method];
        const schema = (
          invokeSchemas[namespace as keyof typeof invokeSchemas] as Record<string, ZodType>
        )[method];
        return [channel, { handler, schema }] as const;
      }),
    ),
  );
  return async (channel: string, args: unknown[]): Promise<Result<unknown>> => {
    const route = routes.get(channel);
    if (!route) return fail('INVALID_INPUT');
    const parsed = route.schema.safeParse(args);
    if (!parsed.success) return fail('INVALID_INPUT');
    if (!route.handler) return fail('NOT_IMPLEMENTED');
    try {
      return await route.handler(...(parsed.data as unknown[]));
    } catch (error) {
      // 不输出底层异常：异常中可能包含本地路径、密钥和会议正文。
      return fail(error instanceof TurnnoteError ? error.code : 'INTERNAL');
    }
  };
}
