import { StrictMode, useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { MeetingSummary } from '@shared/contracts';
import './styles.css';

function App(): ReactElement {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);

  useEffect(() => {
    void window.turnnote.listMeetings().then(setMeetings);
  }, []);

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">TURNNOTE</p>
          <h1>Meeting workspace</h1>
        </div>
        <button type="button" disabled>Start meeting</button>
      </header>
      <section className="empty-state" aria-live="polite">
        <h2>{meetings.length === 0 ? 'No meetings yet' : `${meetings.length} meetings`}</h2>
        <p>The project foundation is ready. Meeting capture and transcription will be added in the next implementation stage.</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
