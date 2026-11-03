import { ipcMain } from 'electron';
import { invokeChannels } from '@shared/contracts';
import { fail } from '@shared/result';
import { createDispatcher, type InvokeHandlers } from '@shared/invoke';
import type { SafeLogger } from './safe-logger';

export function registerIpc(handlers: InvokeHandlers, logger: SafeLogger): void {
  const dispatch = createDispatcher(handlers);
  for (const methods of Object.values(invokeChannels)) {
    for (const channel of Object.values(methods)) {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        if (event.senderFrame !== event.sender.mainFrame) {
          logger.ipcFailure({ channel, code: 'INVALID_INPUT' });
          return fail('INVALID_INPUT');
        }
        const result = await dispatch(channel, args);
        if (!result.ok) logger.ipcFailure({ channel, code: result.error.code });
        return result;
      });
    }
  }
}
