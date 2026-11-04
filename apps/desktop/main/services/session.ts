import type { CapturePermissions } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { ok, requireCondition } from '@shared/result';
import type { MeetingStore } from '../storage/database';
import { createStorageHandlers } from '../storage/handlers';
import { createRecordingHandlers } from '../platform/recording';
import { createTranscriptionService, type TranscriptionOptions } from './transcription';
import { createGenerationService, type GenerationOptions } from './generation';
import { createAudioRetention } from './audio-retention';
import { createExportHandlers, type ExportOptions } from './export';
import { createImportHandlers, type ImportOptions } from './import-audio';
import { createModelHandlers, type ModelManager } from './model-manager';
import { createProviderCatalog } from './ai-providers';
import { createProviderHandlers } from './providers';
import type { CredentialStore } from '../platform/credentials';

/** The same Main composition is exercised in integration tests and Electron. */
export function createSessionServices(
  store: MeetingStore,
  options: TranscriptionOptions &
    Omit<GenerationOptions, 'emitMeeting' | 'emitProgress' | 'catalog'> & {
      permissions: () => CapturePermissions;
      credentials?: CredentialStore;
      /** 未提供时 exports.markdown 返回 NOT_IMPLEMENTED（例如无窗口的测试环境） */
      exports?: ExportOptions;
      /** 未提供时 meetings.importAudio 返回 NOT_IMPLEMENTED（例如无窗口的测试环境） */
      importAudio?: Pick<ImportOptions, 'chooseFile'>;
      /** 转写模型管理；未提供时不设闸门，models.* 返回 NOT_IMPLEMENTED（例如 fake sidecar 的测试环境） */
      models?: ModelManager;
    },
) {
  let shutdown: Promise<void> | undefined;
  let closing = false;
  const emitMeeting: TranscriptionOptions['emitMeeting'] = (meeting) => {
    try {
      options.emitMeeting(structuredClone(meeting));
    } catch {
      /* Window delivery cannot change storage or resource cleanup. */
    }
  };
  const catalog = createProviderCatalog(store, options.credentials);
  const retention = createAudioRetention(store, options.audioDirectory, options.logger);
  const transcription = createTranscriptionService(store, {
    ...options,
    emitMeeting,
    afterTranscribed: retention.tryRelease,
    modelReady: options.models && (() => options.models!.isReady()),
  });
  // 模型下载完成后，补发此前因模型未就绪而没有启动的自动转写
  options.models?.onReady(() => transcription.resumePending());
  const generation = createGenerationService(store, {
    ...options,
    credentials: options.credentials,
    catalog,
    emitMeeting,
  });
  const recording = createRecordingHandlers(
    store,
    options.audioDirectory,
    emitMeeting,
    options.permissions,
    transcription.schedule,
  );
  const storage = createStorageHandlers(
    store,
    options.audioDirectory,
    emitMeeting,
    async (id) => {
      await Promise.all([
        recording.releaseMeeting(id),
        transcription.releaseMeeting(id),
        generation.releaseMeeting(id),
      ]);
    },
    options.credentials,
  );
  const handlers: InvokeHandlers = {
    ...storage,
    ...recording.handlers,
    transcription: transcription.handlers,
    notes: { ...storage.notes, ...generation.handlers },
    providers: createProviderHandlers(catalog, options.credentials, { provider: options.provider }),
    settings: {
      ...storage.settings,
      update: async (patch) => {
        // 只能选择目录里存在的服务商
        requireCondition(!patch.noteProvider || catalog.get(patch.noteProvider), 'INVALID_INPUT');
        const result = await storage.settings!.update!(patch);
        // 切换转写模型后重新广播模型状态（界面据此显示新模型是否可用）
        if (result.ok && 'transcriptionModel' in patch) options.models?.refresh();
        return result;
      },
      // Key 只能保存给目录里存在的服务商，避免给不存在的名字存下孤立的密钥
      setApiKey: async (provider, apiKey) => {
        requireCondition(catalog.get(provider), 'INVALID_INPUT');
        return storage.settings!.setApiKey!(provider, apiKey);
      },
    },
    meetings: {
      ...storage.meetings,
      ...(options.importAudio &&
        createImportHandlers(store, {
          audioDirectory: options.audioDirectory,
          chooseFile: options.importAudio.chooseFile,
          emit: emitMeeting,
          schedule: transcription.schedule,
        })),
      // 取消保留时，已转写会议的音频立即按策略清理；开启保留不会恢复已删除的音频。
      setRetainAudio: async (id, retain) => {
        const result = await storage.meetings!.setRetainAudio!(id, retain);
        if (retain || !retention.tryRelease(id)) return result;
        const meeting = store.get(id);
        emitMeeting(meeting);
        return ok(meeting);
      },
    },
    ...(options.exports && { exports: createExportHandlers(store, options.exports) }),
    ...(options.models && { models: createModelHandlers(options.models) }),
  };
  // Once quitting begins, no IPC call can create resources after shutdown's snapshot.
  for (const methods of Object.values(handlers)) {
    for (const [name, method] of Object.entries(methods)) {
      Object.assign(methods, {
        [name]: (...args: Parameters<typeof method>) => {
          requireCondition(!closing, 'INTERRUPTED');
          return method(...args);
        },
      });
    }
  }
  return {
    handlers,
    async recover() {
      await recording.recover();
      retention.sweep();
      // 上次因关闭应用或模型缺失而停在 captured 的会议，模型就绪时继续转写
      if (options.models?.isReady() ?? true) transcription.resumePending();
    },
    interruptRecording: recording.shutdown,
    shutdown(): Promise<void> {
      closing = true;
      shutdown ??= Promise.allSettled([
        recording.shutdown(),
        transcription.shutdown(),
        generation.shutdown(),
        options.models?.shutdown(),
      ]).then(() => {});
      return shutdown;
    },
  };
}
