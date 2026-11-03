import { invokeChannels, type TurnnoteInvokeApi } from './contracts';

/** 一处构造 invoke 白名单，供 Preload、mock 和契约测试共用。 */
export function createInvokeApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): TurnnoteInvokeApi {
  return Object.fromEntries(
    Object.entries(invokeChannels).map(([namespace, methods]) => [
      namespace,
      Object.fromEntries(
        Object.entries(methods).map(([method, channel]) => [
          method,
          (...args: unknown[]) => invoke(channel, ...args),
        ]),
      ),
    ]),
  ) as unknown as TurnnoteInvokeApi;
}
