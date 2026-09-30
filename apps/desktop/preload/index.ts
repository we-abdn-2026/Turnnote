import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  eventChannels,
  invokeChannels,
  loopbackChannels,
  type TurnnoteApi,
  type TurnnoteInvokeApi,
} from '@shared/contracts';

// 只暴露 invokeChannels 白名单中的通道
const invokeApi = Object.fromEntries(
  Object.entries(invokeChannels).map(([namespace, methods]) => [
    namespace,
    Object.fromEntries(
      Object.entries(methods).map(([method, channel]) => [
        method,
        (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
      ]),
    ),
  ]),
) as unknown as TurnnoteInvokeApi;

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
