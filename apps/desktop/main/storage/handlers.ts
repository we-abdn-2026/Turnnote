import type { MeetingDetail } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { fail, ok, requireCondition } from '@shared/result';
import type { MeetingStore } from './database';
import { removeManagedFile } from './managed-file';
import type { CredentialStore } from '../platform/credentials';

export function createStorageHandlers(
  store: MeetingStore,
  audioDirectory: string,
  emit: (meeting: MeetingDetail) => void,
  releaseMeeting?: (id: string) => Promise<void>,
  credentials?: CredentialStore,
): InvokeHandlers {
  function updated(meeting: MeetingDetail) {
    emit(meeting);
    return ok(meeting);
  }

  async function deleteMeeting(id: string) {
    // 墓碑先提交，任务立即失效；文件删除失败时不丢失清理线索。
    const meeting = store.markDeleted(id);
    emit(meeting);
    await releaseMeeting?.(id);
    // 每段音频都要删除；任何一段失败都保留墓碑，下次启动继续（已删的文件视为成功）
    for (const audio of store.getAudios(id)) {
      try {
        removeManagedFile(audioDirectory, audio.filePath);
      } catch {
        return fail('WRITE_FAILED');
      }
    }
    store.purgeDeleted(id);
    return ok(null);
  }

  return {
    meetings: {
      list: async (query) => ok(store.list(query)),
      get: async (id) => ok(store.get(id)),
      create: async (title) => updated(store.create(title)),
      rename: async (id, title) => updated(store.rename(id, title)),
      setRetainAudio: async (id, retain) => updated(store.setRetainAudio(id, retain)),
      setKeywords: async (id, keywords) => updated(store.setKeywords(id, keywords)),
      delete: async (id) => deleteMeeting(id),
    },
    transcription: { getSegments: async (id) => ok(store.getSegments(id)) },
    notes: {
      getLatest: async (id) => ok(store.getLatestNote(id)),
      saveEdit: async (id, note, expectedVersion) => {
        const version = store.saveEdit(id, note, expectedVersion);
        emit(store.get(id));
        return ok(version);
      },
    },
    settings: {
      get: async () => ok(store.getSettings()),
      update: async (patch) => ok(store.updateSettings(patch)),
      hasApiKey: async (provider) => ok(credentials?.has(provider) ?? false),
      setApiKey: async (provider, apiKey) => {
        requireCondition(credentials !== undefined, 'NOT_IMPLEMENTED');
        credentials.set(provider, apiKey);
        return ok(null);
      },
      clearApiKey: async (provider) => {
        credentials?.clear(provider);
        return ok(null);
      },
    },
  };
}
