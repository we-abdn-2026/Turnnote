import { realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { MeetingDetail } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { fail, ok, requireCondition } from '@shared/result';
import type { MeetingStore } from './database';

export function createStorageHandlers(
  store: MeetingStore,
  audioDirectory: string,
  emit: (meeting: MeetingDetail) => void,
): InvokeHandlers {
  function updated(meeting: MeetingDetail) {
    emit(meeting);
    return ok(meeting);
  }

  function deleteMeeting(id: string) {
    // 墓碑先提交，任务立即失效；文件删除失败时不丢失清理线索。
    const meeting = store.markDeleted(id);
    emit(meeting);
    const audio = store.getAudio(id);
    if (audio) {
      try {
        const root = realpathSync(audioDirectory);
        const parent = realpathSync(dirname(audio.filePath));
        const child = relative(root, resolve(parent, basename(audio.filePath)));
        requireCondition(
          child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child),
          'WRITE_FAILED',
        );
        unlinkSync(audio.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('WRITE_FAILED');
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
    },
  };
}
