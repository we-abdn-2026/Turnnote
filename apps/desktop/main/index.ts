import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { eventChannels } from '@shared/contracts';
import { ok } from '@shared/result';
import { registerIpc } from './ipc';
import { MeetingStore } from './storage/database';
import { createStorageHandlers } from './storage/handlers';
import { runPackagingSmoke } from './packaging-smoke';

let window: BrowserWindow | undefined;
let store: MeetingStore | undefined;
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app
  .whenReady()
  .then(async () => {
    if (!ownsInstance) return;
    if (process.argv.includes('--packaging-smoke')) {
      const result = await runPackagingSmoke(
        process.resourcesPath,
        app.getPath('userData'),
        process.argv.includes('--packaging-smoke-force-failure'),
      );
      console.log(`Packaging validation log: ${result.logPath}`);
      app.exit(result.passed ? 0 : 1);
      return;
    }
    const audioDirectory = join(app.getPath('userData'), 'audio');
    mkdirSync(audioDirectory, { recursive: true });
    store = new MeetingStore(join(app.getPath('userData'), 'turnnote.db'), audioDirectory);
    store.interruptProcessing();
    const storageHandlers = createStorageHandlers(store, audioDirectory, (meeting) => {
      for (const browser of BrowserWindow.getAllWindows()) {
        if (!browser.webContents.isDestroyed()) {
          try {
            browser.webContents.send(eventChannels.meetingUpdated, meeting);
          } catch {
            /* Window closed during delivery. */
          }
        }
      }
    });
    // 清理上次未完成的删除；失败时保留墓碑，下一次启动继续。
    for (const meeting of store.getDeleted()) await storageHandlers.meetings!.delete!(meeting.id);
    registerIpc({
      ...storageHandlers,
      app: {
        getInfo: async () =>
          ok({
            name: 'Turnnote',
            version: app.getVersion(),
            platform: process.platform as 'darwin' | 'win32' | 'linux',
          }),
      },
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch(() => {
    dialog.showErrorBox(
      'Turnnote could not start',
      'Local meeting data could not be opened. Your saved data has been kept. Check disk access and use the latest application version.',
    );
    app.quit();
  });

app.on('will-quit', () => {
  store?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
