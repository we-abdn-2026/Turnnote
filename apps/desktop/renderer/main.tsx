import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MeetingWorkspace } from './workspace/MeetingWorkspace';
import './styles.css';

function App(): ReactElement {
  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">TURNNOTE</p>
          <h1>Meeting workspace</h1>
        </div>
      </header>
      <MeetingWorkspace />
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
