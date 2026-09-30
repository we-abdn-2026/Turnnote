// 内存版 TurnnoteApi，仅用于 `npm run dev:web`，不会进入生产构建。
// 行为按 docs/database-schema.md 的状态机模拟，延迟可通过 delayMs 调整。
import type {
  AppError,
  AppSettings,
  JobProgress,
  MeetingDetail,
  MeetingNote,
  NoteVersion,
  Result,
  TranscriptSegment,
  TurnnoteApi,
} from '@shared/contracts';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: AppError['code'], message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});

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
    {
      task: 'Prepare the release notes',
      owner: 'Alex',
      dueDate: 'unspecified',
      timestampMs: 5200,
    },
  ],
};

export function createMockApi({ delayMs = 400 } = {}): TurnnoteApi {
  const meetings = new Map<string, MeetingDetail>();
  const segments = new Map<string, TranscriptSegment[]>();
  const notes = new Map<string, NoteVersion[]>();
  const meetingListeners = new Set<(meeting: MeetingDetail) => void>();
  const progressListeners = new Set<(progress: JobProgress) => void>();
  let settings: AppSettings = {
    microphoneDeviceId: null,
    includeSystemAudio: true,
    transcriptionModel: 'small',
    transcriptionLanguage: 'auto',
    deepseekModel: 'deepseek-chat',
  };
  let hasApiKey = false;
  let nextId = 1;

  const now = () => new Date().toISOString();
  const wait = (ms = delayMs) => new Promise((resolve) => setTimeout(resolve, ms));

  function update(id: string, patch: Partial<MeetingDetail>): MeetingDetail {
    const meeting = { ...meetings.get(id)!, ...patch, updatedAt: now() };
    meetings.set(id, meeting);
    meetingListeners.forEach((listener) => listener(meeting));
    return meeting;
  }

  function progress(meetingId: string, kind: JobProgress['kind'], percent: number): void {
    progressListeners.forEach((listener) => listener({ meetingId, kind, percent }));
  }

  function create(title: string, patch: Partial<MeetingDetail> = {}): MeetingDetail {
    const id = `mock-${nextId++}`;
    const meeting: MeetingDetail = {
      id,
      title,
      status: 'created',
      createdAt: now(),
      updatedAt: now(),
      retainAudio: false,
      hasAudio: false,
      keywords: [],
      lastError: null,
      ...patch,
    };
    meetings.set(id, meeting);
    return meeting;
  }

  async function runTranscription(id: string): Promise<void> {
    for (const percent of [0, 25, 50, 75, 100]) {
      await wait();
      if (meetings.get(id)?.status !== 'transcribing') return; // 已取消或删除
      progress(id, 'transcribing', percent);
    }
    segments.set(id, SAMPLE_SEGMENTS);
    const retainAudio = meetings.get(id)!.retainAudio;
    update(id, { status: 'transcribed', hasAudio: retainAudio });
  }

  async function runGeneration(id: string): Promise<void> {
    for (const percent of [0, 50, 100]) {
      await wait();
      if (meetings.get(id)?.status !== 'generating') return;
      progress(id, 'generating', percent);
    }
    const versions = notes.get(id) ?? [];
    versions.push({
      version: versions.length + 1,
      source: 'generated',
      note: SAMPLE_NOTE,
      createdAt: now(),
    });
    notes.set(id, versions);
    update(id, { status: 'ready' });
  }

  function withMeeting<T>(id: string, fn: (meeting: MeetingDetail) => Result<T>): Result<T> {
    const meeting = meetings.get(id);
    return meeting ? fn(meeting) : fail('NOT_FOUND', 'Meeting not found.');
  }

  const seeded = create('Weekly sync', { status: 'ready', keywords: ['Pricing'] });
  segments.set(seeded.id, SAMPLE_SEGMENTS);
  notes.set(seeded.id, [{ version: 1, source: 'generated', note: SAMPLE_NOTE, createdAt: now() }]);

  return {
    app: {
      getInfo: async () => ok({ name: 'Turnnote', version: '0.0.0-mock', platform: 'darwin' }),
    },
    meetings: {
      list: async (query) => {
        const q = query?.trim().toLowerCase();
        const matches = [...meetings.values()].filter(
          (meeting) =>
            meeting.status !== 'deleted' &&
            (!q ||
              meeting.title.toLowerCase().includes(q) ||
              (segments.get(meeting.id) ?? []).some((s) => s.text.toLowerCase().includes(q))),
        );
        return ok(
          matches
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
      create: async (title) =>
        title.trim() ? ok(create(title.trim())) : fail('INVALID_INPUT', 'Title is required.'),
      rename: async (id, title) =>
        withMeeting(id, () =>
          title.trim()
            ? ok(update(id, { title: title.trim() }))
            : fail('INVALID_INPUT', 'Title is required.'),
        ),
      setRetainAudio: async (id, retain) =>
        withMeeting(id, () => ok(update(id, { retainAudio: retain }))),
      setKeywords: async (id, keywords) =>
        withMeeting(id, () =>
          ok(update(id, { keywords: [...new Set(keywords.map((k) => k.trim()).filter(Boolean))] })),
        ),
      delete: async (id) =>
        withMeeting(id, () => {
          update(id, { status: 'deleted' });
          meetings.delete(id);
          segments.delete(id);
          notes.delete(id);
          return ok(null);
        }),
      importAudio: async () => {
        const meeting = create('Imported audio', { status: 'transcribing', hasAudio: true });
        void runTranscription(meeting.id);
        return ok(meeting);
      },
    },
    recording: {
      getPermissions: async () => ok({ microphone: 'granted', screen: 'granted' }),
      start: async (id) =>
        withMeeting(id, (meeting) =>
          meeting.status === 'created'
            ? ok(update(id, { status: 'recording', hasAudio: true }))
            : fail('INVALID_STATE', 'Recording can only start on a new meeting.'),
        ),
      appendChunk: async (id) =>
        withMeeting(id, (meeting) =>
          meeting.status === 'recording'
            ? ok(null)
            : fail('INVALID_STATE', 'Meeting is not recording.'),
        ),
      stop: async (id) =>
        withMeeting(id, (meeting) => {
          if (meeting.status !== 'recording') {
            return fail('INVALID_STATE', 'Meeting is not recording.');
          }
          update(id, { status: 'captured' });
          const transcribing = update(id, { status: 'transcribing' });
          void runTranscription(id);
          return ok(transcribing);
        }),
    },
    transcription: {
      start: async (id) =>
        withMeeting(id, (meeting) => {
          if (!['captured', 'failed'].includes(meeting.status) || !meeting.hasAudio) {
            return fail('INVALID_STATE', 'No audio is available to transcribe.');
          }
          const transcribing = update(id, { status: 'transcribing', lastError: null });
          void runTranscription(id);
          return ok(transcribing);
        }),
      cancel: async (id) =>
        withMeeting(id, (meeting) =>
          meeting.status === 'transcribing'
            ? ok(update(id, { status: 'captured' }))
            : fail('INVALID_STATE', 'Meeting is not transcribing.'),
        ),
      getSegments: async (id) => withMeeting(id, () => ok(segments.get(id) ?? [])),
    },
    notes: {
      generate: async (id) =>
        withMeeting(id, (meeting) => {
          if (!['transcribed', 'ready', 'failed'].includes(meeting.status)) {
            return fail('INVALID_STATE', 'Transcript is not ready yet.');
          }
          if (!hasApiKey) {
            return fail('API_KEY_MISSING', 'Add a DeepSeek API key in Settings first.');
          }
          const generating = update(id, { status: 'generating', lastError: null });
          void runGeneration(id);
          return ok(generating);
        }),
      getLatest: async (id) => withMeeting(id, () => ok(notes.get(id)?.at(-1) ?? null)),
      saveEdit: async (id, note) =>
        withMeeting(id, () => {
          const versions = notes.get(id) ?? [];
          const version: NoteVersion = {
            version: versions.length + 1,
            source: 'user',
            note,
            createdAt: now(),
          };
          notes.set(id, [...versions, version]);
          return ok(version);
        }),
    },
    exports: {
      markdown: async (id) =>
        withMeeting(id, () =>
          notes.get(id)?.length
            ? ok({ saved: true })
            : fail('INVALID_STATE', 'There is no note to export.'),
        ),
    },
    settings: {
      get: async () => ok(settings),
      update: async (patch) => {
        settings = { ...settings, ...patch };
        return ok(settings);
      },
      hasApiKey: async () => ok(hasApiKey),
      setApiKey: async (apiKey) => {
        if (!apiKey.trim()) return fail('INVALID_INPUT', 'API key is required.');
        hasApiKey = true;
        return ok(null);
      },
      clearApiKey: async () => {
        hasApiKey = false;
        return ok(null);
      },
    },
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
    // 浏览器中 getDisplayMedia 自带共享音频选项，开关为空操作
    loopback: {
      enable: async () => {},
      disable: async () => {},
    },
  };
}
