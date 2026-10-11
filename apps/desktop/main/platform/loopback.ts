import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import { initMain } from 'electron-audio-loopback';
import { loopbackChannels } from '@shared/contracts';

/** Keep the library's platform setup, harden its fixed IPC handlers for our sandbox. */
export function initializeLoopback(): void {
  initMain();
  for (const channel of Object.values(loopbackChannels)) ipcMain.removeHandler(channel);
  function trusted(event: IpcMainInvokeEvent): boolean {
    return (
      event.senderFrame === event.sender.mainFrame &&
      BrowserWindow.fromWebContents(event.sender) !== null
    );
  }
  ipcMain.handle(loopbackChannels.enable, (event, ...args: unknown[]) => {
    if (!trusted(event) || args.length) throw new Error('Audio capture is unavailable.');
    const owner = event.senderFrame;
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      if (request.frame !== owner) {
        callback({});
        return;
      }
      void desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then(
          (sources) => callback(sources.length ? { video: sources[0], audio: 'loopback' } : {}),
          () => callback({}),
        );
    });
  });
  ipcMain.handle(loopbackChannels.disable, (event, ...args: unknown[]) => {
    if (!trusted(event) || args.length) throw new Error('Audio capture is unavailable.');
    session.defaultSession.setDisplayMediaRequestHandler(null);
  });
}
