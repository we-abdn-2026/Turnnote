import { ipcMain } from 'electron';
import { invokeChannels } from '@shared/contracts';
import { fail } from '@shared/result';
import { createDispatcher, type InvokeHandlers } from '@shared/invoke';

export function registerIpc(handlers: InvokeHandlers): void {
  const dispatch = createDispatcher(handlers);
  for (const methods of Object.values(invokeChannels)) {
    for (const channel of Object.values(methods)) {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        if (event.senderFrame !== event.sender.mainFrame) return fail('INVALID_INPUT');
        return dispatch(channel, args);
      });
    }
  }
}
