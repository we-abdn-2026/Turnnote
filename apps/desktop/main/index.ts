import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { MeetingSummary, TurnnoteApi } from '@shared/contracts';

let window: BrowserWindow | undefined;

const meetings: MeetingSummary[] = [];

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

function registerIpc(): void {
  ipcMain.handle('app:get-info', () => ({ name: 'Turnnote', version: app.getVersion() } satisfies Awaited<ReturnType<TurnnoteApi['getAppInfo']>>));
  ipcMain.handle('meetings:list', () => meetings satisfies Awaited<ReturnType<TurnnoteApi['listMeetings']>>);
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
