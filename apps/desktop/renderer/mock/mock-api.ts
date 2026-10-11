// 内存版 TurnnoteApi，仅用于 dev:web；状态规则和参数校验与 Main 共用。
import type {
  AppError,
  AppSettings,
  ErrorCode,
  JobKind,
  JobProgress,
  MeetingDetail,
  MeetingNote,
  NoteVersion,
  Result,
  TranscriptSegment,
  TurnnoteApi,
  TurnnoteInvokeApi,
} from '@shared/contracts';
import { createInvokeApi } from '@shared/bridge';
import { createDispatcher } from '@shared/invoke';
import { canCancelRecording, canEditNote, canStartJob } from '@shared/lifecycle';
import { errorMessages, fail, ok } from '@shared/result';
import { defaultSettings } from '@shared/schemas';

const SAMPLE_SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 2400, text: "Let's review the launch plan for this week." },
  { startMs: 2400, endMs: 5200, text: 'We agreed to ship the beta on Friday.' },
  { startMs: 5200, endMs: 8000, text: 'Alex will prepare the release notes.' },
  { startMs: 8000, endMs: 11000, text: 'Pricing for the team plan is still open.' },
];
const SAMPLE_NOTE: MeetingNote = {
  summary: 'The team reviewed the launch plan and agreed on a Friday beta release.',
  keyTopics: ['Launch plan', 'Pricing'],
  decisions: [{ text: 'Ship the beta on Friday.', timestampMs: 2400 }],
  openQuestions: ['What is the team plan price?'],
  actionItems: [
    { task: 'Prepare the release notes', owner: 'Alex', dueDate: 'unspecified', timestampMs: 5200 },
  ],
};
interface MockJob {
  id: string;
  kind: JobKind;
  baseVersion: number;
  keywords: string[];
}
interface MockOptions {
  delayMs?: number;
  seed?: boolean;
  transcriptionError?: ErrorCode;
  generationError?: ErrorCode;
}

export function createMockApi({
  delayMs = 400,
  seed = true,
  transcriptionError,
  generationError,
}: MockOptions = {}): TurnnoteApi {
  const meetings = new Map<string, MeetingDetail>();
  const segments = new Map<string, TranscriptSegment[]>();
  const notes = new Map<string, NoteVersion[]>();
  const jobs = new Map<string, MockJob>();
  const pendingTranscriptions = new Map<string, ReturnType<typeof setTimeout>>();
  const meetingListeners = new Set<(meeting: MeetingDetail) => void>();
  const progressListeners = new Set<(progress: JobProgress) => void>();
  let settings = structuredClone(defaultSettings);
  let hasApiKey = false;
  let nextId = 1;
  let nextJobId = 1;
  const now = () => new Date().toISOString();
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));

  function cancelAutoTranscription(id: string): void {
    clearTimeout(pendingTranscriptions.get(id));
    pendingTranscriptions.delete(id);
  }
  function scheduleAutoTranscription(id: string): void {
    cancelAutoTranscription(id);
    const timer = setTimeout(() => {
      if (pendingTranscriptions.get(id) !== timer) return;
      pendingTranscriptions.delete(id);
      if (meetings.get(id)?.status === 'captured') startJob(id, 'transcribing');
    }, 0);
    pendingTranscriptions.set(id, timer);
  }

  function update(id: string, patch: Partial<MeetingDetail>): MeetingDetail {
    const meeting = {
      ...meetings.get(id)!,
      ...structuredClone(patch),
      activeJobId: jobs.get(id)?.id ?? null,
      updatedAt: now(),
    };
    meetings.set(id, meeting);
    // 观察者异常和修改不能破坏状态提交或其他观察者。
    for (const listener of meetingListeners) {
      try {
        listener(structuredClone(meeting));
      } catch {
        /* UI listener owns its failure. */
      }
    }
    return structuredClone(meeting);
  }
  function create(title: string, patch: Partial<MeetingDetail> = {}): MeetingDetail {
    const meeting: MeetingDetail = {
      id: `mock-${nextId++}`,
      title,
      status: 'created',
      createdAt: now(),
      updatedAt: now(),
      retainAudio: false,
      hasAudio: false,
      keywords: [],
      lastError: null,
      activeJobId: null,
      ...patch,
    };
    meetings.set(meeting.id, meeting);
    return structuredClone(meeting);
  }
  function withMeeting<T>(id: string, fn: (meeting: MeetingDetail) => Result<T>): Result<T> {
    const meeting = meetings.get(id);
    return meeting && meeting.status !== 'deleted'
      ? fn(structuredClone(meeting))
      : fail('NOT_FOUND');
  }
  function begin(id: string, kind: JobKind): { job: MockJob; meeting: MeetingDetail } {
    cancelAutoTranscription(id);
    const job: MockJob = {
      id: `mock-job-${nextJobId++}`,
      kind,
      baseVersion: notes.get(id)?.at(-1)?.version ?? 0,
      keywords: [...meetings.get(id)!.keywords],
    };
    jobs.set(id, job);
    const meeting = update(id, {
      status: kind,
      lastError: null,
      hasAudio: kind === 'recording' || meetings.get(id)!.hasAudio,
    });
    return { job, meeting };
  }
  function isCurrent(id: string, job: MockJob): boolean {
    return jobs.get(id)?.id === job.id && meetings.get(id)?.status === job.kind;
  }
  function failed(id: string, job: MockJob, code: AppError['code']): MeetingDetail {
    jobs.delete(id);
    return update(id, {
      status: 'failed',
      lastError: { kind: job.kind, jobId: job.id, code, message: errorMessages[code] },
    });
  }
  async function runJob(id: string, job: MockJob): Promise<void> {
    if (job.kind === 'recording') return;
    for (const percent of job.kind === 'transcribing' ? [0, 25, 50, 75, 100] : [0, 50, 100]) {
      await wait();
      if (!isCurrent(id, job)) return;
      for (const listener of progressListeners) {
        try {
          listener({ meetingId: id, jobId: job.id, kind: job.kind, percent });
        } catch {
          /* See update(). */
        }
      }
      if (!isCurrent(id, job)) return; // 事件回调可能取消、重试或删除。
    }
    const error = job.kind === 'transcribing' ? transcriptionError : generationError;
    if (error) {
      failed(id, job, error);
      return;
    }
    if (job.kind === 'transcribing') {
      segments.set(id, structuredClone(SAMPLE_SEGMENTS));
      jobs.delete(id);
      update(id, { status: 'transcribed', hasAudio: meetings.get(id)!.retainAudio });
    } else {
      const versions = notes.get(id) ?? [];
      if ((versions.at(-1)?.version ?? 0) !== job.baseVersion) {
        failed(id, job, 'CONFLICT');
        return;
      }
      const note = structuredClone(SAMPLE_NOTE);
      note.keyTopics = [...new Set([...note.keyTopics, ...job.keywords])];
      versions.push({ version: versions.length + 1, source: 'generated', note, createdAt: now() });
      notes.set(id, versions);
      jobs.delete(id);
      update(id, { status: 'ready' });
    }
  }
  function startJob(id: string, kind: Exclude<JobKind, 'recording'>): Result<MeetingDetail> {
    return withMeeting(id, (meeting) => {
      if (!canStartJob(meeting, kind, (segments.get(id)?.length ?? 0) > 0))
        return fail('INVALID_STATE');
      if (kind === 'generating' && !hasApiKey) return fail('API_KEY_MISSING');
      const { job, meeting: snapshot } = begin(id, kind);
      void runJob(id, job);
      return ok(snapshot);
    });
  }

  if (seed) {
    const meeting = create('Weekly sync', { status: 'ready', keywords: ['Pricing'] });
    segments.set(meeting.id, structuredClone(SAMPLE_SEGMENTS));
    notes.set(meeting.id, [
      { version: 1, source: 'generated', note: structuredClone(SAMPLE_NOTE), createdAt: now() },
    ]);
  }

  const handlers: TurnnoteInvokeApi = {
    app: {
      getInfo: async () => ok({ name: 'Turnnote', version: '0.0.0-mock', platform: 'darwin' }),
    },
    meetings: {
      list: async (query) => {
        const q = query?.toLowerCase();
        return ok(
          [...meetings.values()]
            .filter(
              (meeting) =>
                meeting.status !== 'deleted' &&
                (!q ||
                  meeting.title.toLowerCase().includes(q) ||
                  (segments.get(meeting.id) ?? []).some((s) => s.text.toLowerCase().includes(q))),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
            .map(({ id, title, status, createdAt, updatedAt }) => ({
              id,
              title,
              status,
              createdAt,
              updatedAt,
            })),
        );
      },
      get: async (id) => withMeeting(id, ok),
      create: async (title) => {
        const meeting = create(title);
        return ok(update(meeting.id, {}));
      },
      rename: async (id, title) => withMeeting(id, () => ok(update(id, { title }))),
      setRetainAudio: async (id, retain) =>
        withMeeting(id, () => ok(update(id, { retainAudio: retain }))),
      setKeywords: async (id, keywords) => withMeeting(id, () => ok(update(id, { keywords }))),
      delete: async (id) =>
        withMeeting(id, () => {
          cancelAutoTranscription(id);
          jobs.delete(id);
          update(id, { status: 'deleted' });
          meetings.delete(id);
          segments.delete(id);
          notes.delete(id);
          return ok(null);
        }),
      importAudio: async () => {
        const meeting = create('Imported audio', { status: 'captured', hasAudio: true });
        scheduleAutoTranscription(meeting.id);
        return ok(meeting);
      },
    },
    recording: {
      getPermissions: async () => ok({ microphone: 'granted', screen: 'granted' }),
      start: async (id) =>
        withMeeting(id, (meeting) => {
          if (!canStartJob(meeting, 'recording', false)) return fail('INVALID_STATE');
          return ok(begin(id, 'recording').meeting);
        }),
      appendChunk: async (id, jobId) =>
        withMeeting(id, (meeting) =>
          meeting.status === 'recording' && meeting.activeJobId === jobId
            ? ok(null)
            : fail('INVALID_STATE'),
        ),
      stop: async (id, jobId) =>
        withMeeting(id, (meeting) => {
          if (meeting.status !== 'recording' || meeting.activeJobId !== jobId)
            return fail('INVALID_STATE');
          jobs.delete(id);
          // 先登记再发布 captured，事件监听器立即启动/取消时也能使其失效。
          scheduleAutoTranscription(id);
          const captured = update(id, { status: 'captured' });
          // 返回已提交的 captured 快照；自动转写通过后续事件推进。
          return ok(captured);
        }),
      cancel: async (id, jobId) =>
        withMeeting(id, (meeting) => {
          if (
            !canCancelRecording(meeting) ||
            (meeting.activeJobId ?? meeting.lastError?.jobId) !== jobId
          )
            return fail('INVALID_STATE');
          jobs.delete(id);
          return ok(update(id, { status: 'created', hasAudio: false, lastError: null }));
        }),
      fail: async (id, jobId, code) =>
        withMeeting(id, (meeting) => {
          if (meeting.status !== 'recording' || meeting.activeJobId !== jobId)
            return fail('INVALID_STATE');
          return ok(failed(id, jobs.get(id)!, code));
        }),
    },
    transcription: {
      start: async (id) => startJob(id, 'transcribing'),
      cancel: async (id, jobId) =>
        withMeeting(id, (meeting) => {
          if (meeting.status !== 'transcribing' || meeting.activeJobId !== jobId)
            return fail('INVALID_STATE');
          cancelAutoTranscription(id);
          jobs.delete(id);
          return ok(update(id, { status: 'captured', lastError: null }));
        }),
      getSegments: async (id) => withMeeting(id, () => ok(structuredClone(segments.get(id) ?? []))),
    },
    notes: {
      generate: async (id) => startJob(id, 'generating'),
      getLatest: async (id) =>
        withMeeting(id, () => ok(structuredClone(notes.get(id)?.at(-1) ?? null))),
      saveEdit: async (id, note, expectedVersion) =>
        withMeeting(id, (meeting) => {
          if (!canEditNote(meeting)) return fail('INVALID_STATE');
          const versions = notes.get(id) ?? [];
          if ((versions.at(-1)?.version ?? 0) !== expectedVersion) return fail('CONFLICT');
          const version: NoteVersion = {
            version: versions.length + 1,
            source: 'user',
            note: structuredClone(note),
            createdAt: now(),
          };
          notes.set(id, [...versions, version]);
          update(id, {
            status: meeting.status === 'generating' ? 'generating' : 'ready',
            lastError: null,
          });
          return ok(structuredClone(version));
        }),
    },
    exports: {
      markdown: async (id) =>
        withMeeting(id, () =>
          notes.get(id)?.length ? ok({ saved: true }) : fail('INVALID_STATE'),
        ),
    },
    settings: {
      get: async () => ok(structuredClone(settings)),
      update: async (patch: Partial<AppSettings>) => {
        settings = { ...settings, ...structuredClone(patch) };
        return ok(structuredClone(settings));
      },
      hasApiKey: async () => ok(hasApiKey),
      setApiKey: async () => {
        hasApiKey = true;
        return ok(null);
      },
      clearApiKey: async () => {
        hasApiKey = false;
        return ok(null);
      },
    },
  };
  const dispatch = createDispatcher(handlers);
  return {
    ...createInvokeApi((channel, ...args) => dispatch(channel, args)),
    events: {
      onMeetingUpdated: (listener) => {
        meetingListeners.add(listener);
        return () => meetingListeners.delete(listener);
      },
      onJobProgress: (listener) => {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
    },
    loopback: { enable: async () => {}, disable: async () => {} },
  };
}
