import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { ok, registerIpc } from './ipc';

let window: BrowserWindow | undefined;

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

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  registerIpc({
    app: {
      getInfo: async () =>
        ok({
          name: 'Turnnote',
          version: app.getVersion(),
          platform: process.platform as 'darwin' | 'win32' | 'linux',
        }),
    },
    meetings: {
      list: async () => ok([]),
    },
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
