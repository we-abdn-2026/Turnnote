import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  safeStorage,
  systemPreferences,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { eventChannels } from '@shared/contracts';
import { ok } from '@shared/result';
import { registerIpc } from './ipc';
import { MeetingStore } from './storage/database';
import { runPackagingSmoke } from './packaging-smoke';
import { createSessionServices } from './services/session';
import { resolveSidecarCommand } from './services/sidecar-command';
import { initializeLoopback } from './platform/loopback';
import { SafeLogger, safeLogPath } from './safe-logger';
import { CredentialStore } from './platform/credentials';
import { createModelManager } from './services/model-manager';

// The package probe does not initialize capture IPC or acquire media permissions.
if (!process.argv.includes('--packaging-smoke')) initializeLoopback();
let services: ReturnType<typeof createSessionServices> | undefined;
let shuttingDown = false;

let window: BrowserWindow | undefined;
let store: MeetingStore | undefined;
let logger: SafeLogger | undefined;
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

// 有可用窗口时作为模态对话框，否则独立弹出
function showSaveDialog(options: SaveDialogOptions) {
  return window && !window.isDestroyed()
    ? dialog.showSaveDialog(window, options)
    : dialog.showSaveDialog(options);
}
function showOpenDialog(options: OpenDialogOptions) {
  return window && !window.isDestroyed()
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options);
}

function interruptRecording(): void {
  void services?.interruptRecording().catch((error) => {
    logger?.error('main', 'recording_interrupt_failed', 'INTERNAL', error);
    /* Keep ownership for retry; startup recovery handles unavailable storage. */
  });
}

// 与 Renderer 的 --paper / --ink 一致；窗口底色先于页面绘制，避免启动闪白或闪黑
const WINDOW_THEME = {
  light: { paper: '#f9f6f2', ink: '#26241f' },
  dark: { paper: '#171613', ink: '#eae8e3' },
};

function windowTheme(): { paper: string; ink: string } {
  return nativeTheme.shouldUseDarkColors ? WINDOW_THEME.dark : WINDOW_THEME.light;
}

function createWindow(): void {
  const theme = windowTheme();
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    // 380px 是开会时贴在视频会议旁的监看窗口宽度；背景色与 Renderer 底色一致，避免启动白屏。
    minWidth: 380,
    minHeight: 560,
    backgroundColor: theme.paper,
    // Renderer 自绘标题栏：macOS 内嵌交通灯，Windows/Linux 使用系统窗口按钮覆盖层。
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 16 } }
      : { titleBarOverlay: { color: theme.paper, symbolColor: theme.ink, height: 48 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  nativeTheme.on('updated', () => {
    const next = windowTheme();
    window?.setBackgroundColor(next.paper);
    if (process.platform !== 'darwin') {
      window?.setTitleBarOverlay({ color: next.paper, symbolColor: next.ink, height: 48 });
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('did-start-navigation', interruptRecording);
  window.webContents.on('render-process-gone', interruptRecording);
  window.webContents.on('destroyed', interruptRecording);

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
    logger = new SafeLogger(safeLogPath(app.getPath('userData')));
    logger.info('main', 'started');
    if (process.argv.includes('--packaging-smoke')) {
      const result = await runPackagingSmoke(process.resourcesPath, app.getPath('userData'));
      console.log('Packaging validation report written.');
      app.exit(result.passed ? 0 : 1);
      return;
    }
    const audioDirectory = join(app.getPath('userData'), 'audio');
    mkdirSync(audioDirectory, { recursive: true });
    store = new MeetingStore(join(app.getPath('userData'), 'turnnote.db'), audioDirectory);
    store.interruptProcessing();
    const publish = (channel: string, payload: unknown) => {
      for (const browser of BrowserWindow.getAllWindows()) {
        if (!browser.webContents.isDestroyed()) {
          try {
            browser.webContents.send(channel, payload);
          } catch {
            /* Window closed during delivery. */
          }
        }
      }
    };
    const modelSources = process.env.TURNNOTE_MODEL_SOURCES?.split(',')
      .map((source) => source.trim())
      .filter(Boolean);
    const models = createModelManager({
      modelsDirectory: join(app.getPath('userData'), 'models'),
      getModelName: () => store!.getSettings().transcriptionModel,
      emit: (status) => publish(eventChannels.modelStatus, status),
      // fake sidecar 不加载模型，不需要下载
      required: process.env.TURNNOTE_ASR_FAKE !== '1',
      sources: modelSources?.length ? modelSources : undefined,
      logger,
    });
    services = createSessionServices(store, {
      audioDirectory,
      models,
      modelsDirectory: join(app.getPath('userData'), 'models'),
      exports: {
        chooseSavePath: async (defaultFileName) => {
          const result = await showSaveDialog({
            title: '导出 Markdown',
            defaultPath: defaultFileName,
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          });
          return result.canceled || !result.filePath ? null : result.filePath;
        },
      },
      importAudio: {
        chooseFile: async () => {
          const result = await showOpenDialog({
            title: '导入音频文件',
            properties: ['openFile'],
            filters: [{ name: '音频', extensions: ['wav', 'mp3', 'm4a'] }],
          });
          return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
        },
      },
      credentials: new CredentialStore(
        join(app.getPath('userData'), 'credentials.json'),
        safeStorage,
      ),
      sidecar: () =>
        resolveSidecarCommand({
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
        }),
      emitMeeting: (meeting) => publish(eventChannels.meetingUpdated, meeting),
      emitProgress: (progress) => publish(eventChannels.jobProgress, progress),
      logger,
      permissions: () => ({
        microphone:
          process.platform === 'darwin'
            ? systemPreferences.getMediaAccessStatus('microphone')
            : 'unknown',
        screen:
          process.platform === 'darwin'
            ? systemPreferences.getMediaAccessStatus('screen')
            : process.platform === 'win32'
              ? 'granted'
              : 'unknown',
      }),
    });
    await services.recover();
    // 模型缺失时在后台自动下载，不阻塞窗口；进度通过 events:model-status 推送
    models.ensure();
    // 清理上次未完成的删除；失败时保留墓碑，下一次启动继续。
    for (const meeting of store.getDeleted()) await services.handlers.meetings!.delete!(meeting.id);
    registerIpc(
      {
        ...services.handlers,
        app: {
          getInfo: async () =>
            ok({
              name: 'Turnnote',
              version: app.getVersion(),
              platform: process.platform as 'darwin' | 'win32' | 'linux',
            }),
        },
      },
      logger,
    );
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    logger?.error('main', 'startup_failed', 'INTERNAL', error);
    dialog.showErrorBox(
      'Turnnote could not start',
      'Local meeting data could not be opened. Your saved data has been kept. Check disk access and use the latest application version.',
    );
    app.quit();
  });

app.on('will-quit', () => {
  store?.close();
});

app.on('before-quit', (event) => {
  if (shuttingDown || !services) return;
  event.preventDefault();
  shuttingDown = true;
  void services.shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
