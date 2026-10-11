import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

async function bootstrap(): Promise<void> {
  let recordingFactory;
  // `npm run dev:web` 没有 Preload，改用内存 mock；生产构建中该分支被整体移除
  if (import.meta.env.MODE === 'mock') {
    const { createMockApi } = await import('./mock/mock-api');
    window.turnnote = createMockApi();
    const { createMockRecording } = await import('./mock/mock-recording');
    recordingFactory = createMockRecording;
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App recordingFactory={recordingFactory} />
    </StrictMode>,
  );
}

void bootstrap();
