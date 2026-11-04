import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react';
import type { AiProviderInfo, AppSettings, TurnnoteApi } from '@shared/contracts';
import { createCaptureRecording } from './audio/meeting-recording';
import { Library } from './library/Library';
import { createMeetingLibrary } from './library/meeting-library';
import { SidebarResizer, useSidebarWidth } from './shell/SidebarResizer';
import { TopBar } from './shell/TopBar';
import { SettingsSheet } from './settings/SettingsSheet';
import { ModelBanner, useModelStatus } from './shell/ModelBanner';
import { useShortcuts } from './ui/shortcuts';
import { createMeetingSession, type MeetingRecording } from './workspace/meeting-session';
import { MeetingWorkspace } from './workspace/MeetingWorkspace';
import { GENERIC_SERVICE, deriveNoteService, type NoteService } from './settings/provider-view';
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
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  // 当前纪要服务的名称、模型和数据去向，全部来自 Main 的服务商目录
  const [noteService, setNoteService] = useState<NoteService | null>(null);
  const modelStatus = useModelStatus(window.turnnote);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const elapsedMs = useSyncExternalStore(clock.subscribe, clock.getSnapshot);

  useEffect(() => session.connect(), [session]);
  useEffect(
    () => library.connect((listener) => session.watchMeetings(listener)),
    [library, session],
  );
  useEffect(() => clock.connect(), [clock]);

  // 读取失败时用通用名称，不猜测服务商
  useEffect(() => {
    let active = true;
    void Promise.all([window.turnnote.settings.get(), window.turnnote.providers.list()])
      .then(([settings, providers]) => {
        if (active && settings.ok && providers.ok) {
          setNoteService(deriveNoteService(settings.value, providers.value));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const onSettingsChanged = useCallback(
    (settings: AppSettings, providers: AiProviderInfo[]) =>
      setNoteService(deriveNoteService(settings, providers)),
    [],
  );

  const provider = noteService ?? GENERIC_SERVICE;
  const hasMeeting = !!state.meeting && state.meeting.status !== 'deleted';

  const focusLibrary = useCallback((id: string) => {
    setLibraryOpen(true);
    // 抽屉模式下元素在展开前不可聚焦，等一帧再聚焦
    window.requestAnimationFrame(() => document.getElementById(id)?.focus());
  }, []);
  const shortcuts = useMemo(
    () => ({
      n: () => focusLibrary('meeting-title'),
      k: () => focusLibrary('library-search'),
      '\\': () => setLibraryOpen((open) => !open),
      j: () => (hasMeeting ? setDrawerOpen((open) => !open) : undefined),
      ',': () => setSettingsOpen(true),
    }),
    [focusLibrary, hasMeeting],
  );
  useShortcuts(shortcuts);

  return (
    <div
      className="shell"
      data-chrome={chrome}
      data-library={libraryOpen ? 'open' : 'closed'}
      style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}
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
      <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} />
      <div className="scrim" aria-hidden="true" onClick={() => setLibraryOpen(false)} />
      <MeetingWorkspace
        session={session}
        state={state}
        elapsedMs={elapsedMs}
        provider={provider}
        drawerOpen={drawerOpen}
        onDrawer={setDrawerOpen}
      />
      <ModelBanner api={window.turnnote} status={modelStatus} />
      {settingsOpen && (
        <SettingsSheet onClose={() => setSettingsOpen(false)} onChanged={onSettingsChanged} />
      )}
    </div>
  );
}
