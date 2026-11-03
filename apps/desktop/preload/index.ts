import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { eventChannels, loopbackChannels, type TurnnoteApi } from '@shared/contracts';
import { createInvokeApi } from '@shared/bridge';

// 只暴露 invokeChannels 白名单中的通道
const invokeApi = createInvokeApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: TurnnoteApi = {
  ...invokeApi,
  events: {
    onMeetingUpdated: (listener) => subscribe(eventChannels.meetingUpdated, listener),
    onJobProgress: (listener) => subscribe(eventChannels.jobProgress, listener),
  },
  loopback: {
    enable: () => ipcRenderer.invoke(loopbackChannels.enable),
    disable: () => ipcRenderer.invoke(loopbackChannels.disable),
  },
};

contextBridge.exposeInMainWorld('turnnote', api);
