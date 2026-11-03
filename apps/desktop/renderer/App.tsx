import { useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { AppSettings, TurnnoteApi } from '@shared/contracts';
import { createCaptureRecording } from './audio/meeting-recording';
import { Library } from './library/Library';
import { createMeetingLibrary } from './library/meeting-library';
import { TopBar } from './shell/TopBar';
import { SettingsSheet } from './settings/SettingsSheet';
import { providerInfo } from './ui/providers';
import { createMeetingSession, type MeetingRecording } from './workspace/meeting-session';
import { MeetingWorkspace } from './workspace/MeetingWorkspace';
import { createRecordingClock } from './workspace/recording-clock';

/** Electron 窗口使用自绘标题栏；浏览器 dev:web 没有窗口按钮，不预留位置 */
function windowChrome(): 'darwin' | 'win32' | 'linux' | 'browser' {
  const agent = navigator.userAgent;
  if (!agent.includes('Electron/')) return 'browser';
  if (agent.includes('Mac OS X')) return 'darwin';
  if (agent.includes('Windows')) return 'win32';
  return 'linux';
}

export function App({
  recordingFactory = createCaptureRecording,
}: {
  recordingFactory?: (api: TurnnoteApi) => MeetingRecording;
}): ReactElement {
  const [session] = useState(() =>
    createMeetingSession(window.turnnote, recordingFactory(window.turnnote)),
  );
  const [library] = useState(() => createMeetingLibrary(window.turnnote));
  const [clock] = useState(() => createRecordingClock(session));
  const [chrome] = useState(windowChrome);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noteSettings, setNoteSettings] = useState<Pick<
    AppSettings,
    'noteProvider' | 'noteModel'
  > | null>(null);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const elapsedMs = useSyncExternalStore(clock.subscribe, clock.getSnapshot);

  useEffect(() => session.connect(), [session]);
  useEffect(
    () => library.connect((listener) => session.watchMeetings(listener)),
    [library, session],
  );
  useEffect(() => clock.connect(), [clock]);

  // 纪要服务的名称和模型来自设置；读取失败时用通用名称，不写死服务商
  useEffect(() => {
    let active = true;
    void window.turnnote.settings
      .get()
      .then((result) => {
        if (active && result.ok) setNoteSettings(result.value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const onSettingsChanged = useCallback((settings: AppSettings) => setNoteSettings(settings), []);

  const provider = noteSettings
    ? { label: providerInfo(noteSettings.noteProvider).label, model: noteSettings.noteModel }
    : { label: 'AI 服务', model: '' };
  const hasMeeting = !!state.meeting && state.meeting.status !== 'deleted';

  return (
    <div
      className="shell"
      data-chrome={chrome}
      data-library={libraryOpen ? 'open' : 'closed'}
      data-recording={state.meeting?.status === 'recording' ? 'true' : undefined}
    >
      <TopBar
        libraryOpen={libraryOpen}
        drawerOpen={drawerOpen}
        canShowDrawer={hasMeeting}
        onToggleLibrary={() => setLibraryOpen((open) => !open)}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Library
        session={session}
        state={state}
        library={library}
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
      />
      <div className="scrim" aria-hidden="true" onClick={() => setLibraryOpen(false)} />
      <MeetingWorkspace
        session={session}
        state={state}
        elapsedMs={elapsedMs}
        provider={provider}
        drawerOpen={drawerOpen}
        onDrawer={setDrawerOpen}
      />
      {settingsOpen && (
        <SettingsSheet onClose={() => setSettingsOpen(false)} onChanged={onSettingsChanged} />
      )}
    </div>
  );
}
