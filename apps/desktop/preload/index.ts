import { contextBridge, ipcRenderer } from 'electron';
import type { TurnnoteApi } from '@shared/contracts';

const api: TurnnoteApi = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  listMeetings: () => ipcRenderer.invoke('meetings:list'),
};

contextBridge.exposeInMainWorld('turnnote', api);
