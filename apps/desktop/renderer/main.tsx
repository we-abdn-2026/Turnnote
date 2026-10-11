import { StrictMode, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { MeetingSummary } from '@shared/contracts';
import './styles.css';
import { RecordingControls } from './audio/recording-controls';

function App(): ReactElement {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);

  useEffect(() => {
    void window.turnnote.meetings.list().then((result) => {
      if (result.ok) setMeetings(result.value);
    });
    return window.turnnote.events.onMeetingUpdated(() => {
      void window.turnnote.meetings.list().then((result) => {
        if (result.ok) setMeetings(result.value);
      });
    });
  }, []);

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">TURNNOTE</p>
          <h1>Meeting workspace</h1>
        </div>
        <RecordingControls />
      </header>
      <section className="empty-state" aria-live="polite">
        <h2>{meetings.length === 0 ? 'No meetings yet' : `${meetings.length} meetings`}</h2>
        <p>
          Record microphone and system audio locally. Transcription will be added in the next
          implementation stage.
        </p>
      </section>
    </main>
  );
}

async function bootstrap(): Promise<void> {
  // `npm run dev:web` 没有 Preload，改用内存 mock；生产构建中该分支被整体移除
  if (import.meta.env.MODE === 'mock') {
    const { createMockApi } = await import('./mock/mock-api');
    window.turnnote = createMockApi();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
