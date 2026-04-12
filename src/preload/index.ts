import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { MystApi } from '@shared/api';

const api: MystApi = {
  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.Settings.Get),
    setOpenRouterKey: (key) => ipcRenderer.invoke(IpcChannels.Settings.SetOpenRouterKey, key),
    hasOpenRouterKey: () => ipcRenderer.invoke(IpcChannels.Settings.HasOpenRouterKey),
    clearOpenRouterKey: () => ipcRenderer.invoke(IpcChannels.Settings.ClearOpenRouterKey),
    setDefaultModel: (model) => ipcRenderer.invoke(IpcChannels.Settings.SetDefaultModel, model),
  },
  projects: {
    createNew: () => ipcRenderer.invoke(IpcChannels.Projects.CreateNew),
    open: () => ipcRenderer.invoke(IpcChannels.Projects.Open),
    getCurrent: () => ipcRenderer.invoke(IpcChannels.Projects.GetCurrent),
    close: () => ipcRenderer.invoke(IpcChannels.Projects.Close),
    listRecent: () => ipcRenderer.invoke(IpcChannels.Projects.ListRecent),
  },
  document: {
    read: () => ipcRenderer.invoke(IpcChannels.Document.Read),
    write: (content) => ipcRenderer.invoke(IpcChannels.Document.Write, content),
    onChanged: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.Document.Changed, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.Document.Changed, handler);
      };
    },
  },
  chat: {
    send: (message) => ipcRenderer.invoke(IpcChannels.Chat.Send, message),
    history: () => ipcRenderer.invoke(IpcChannels.Chat.History),
    clear: () => ipcRenderer.invoke(IpcChannels.Chat.Clear),
    onChunk: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, chunk: string): void => {
        callback(chunk);
      };
      ipcRenderer.on(IpcChannels.Chat.Chunk, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.Chat.Chunk, handler);
      };
    },
    onChunkDone: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.Chat.ChunkDone, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.Chat.ChunkDone, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('myst', api);
