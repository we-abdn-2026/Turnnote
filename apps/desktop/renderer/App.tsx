import type { ReactElement } from 'react';
import type { TurnnoteApi } from '@shared/contracts';
import type { MeetingRecording } from './workspace/meeting-session';
import { AudioDeviceSelector } from './components/AudioDeviceSelector';
import { MeetingWorkspace } from './workspace/MeetingWorkspace';

export function App({
  recordingFactory,
}: {
  recordingFactory?: (api: TurnnoteApi) => MeetingRecording;
}): ReactElement {
  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">TURNNOTE</p>
          <h1>Meeting workspace</h1>
        </div>
      </header>
      <AudioDeviceSelector />
      <MeetingWorkspace recordingFactory={recordingFactory} />
    </main>
  );
}
