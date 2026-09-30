/// <reference types="vite/client" />
import type { TurnnoteApi } from '@shared/contracts';

declare global {
  interface Window {
    turnnote: TurnnoteApi;
  }
}

export {};
