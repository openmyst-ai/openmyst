import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { MystApi } from '@shared/api';
import type { DeepPlanResearchEvent } from '@shared/types';

const api: MystApi = {
  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.Settings.Get),
    setOpenRouterKey: (key) => ipcRenderer.invoke(IpcChannels.Settings.SetOpenRouterKey, key),
    hasOpenRouterKey: () => ipcRenderer.invoke(IpcChannels.Settings.HasOpenRouterKey),
    clearOpenRouterKey: () => ipcRenderer.invoke(IpcChannels.Settings.ClearOpenRouterKey),
    setDefaultModel: (model) => ipcRenderer.invoke(IpcChannels.Settings.SetDefaultModel, model),
    setJinaKey: (key) => ipcRenderer.invoke(IpcChannels.Settings.SetJinaKey, key),
    hasJinaKey: () => ipcRenderer.invoke(IpcChannels.Settings.HasJinaKey),
    clearJinaKey: () => ipcRenderer.invoke(IpcChannels.Settings.ClearJinaKey),
    setDeepPlanModel: (model) => ipcRenderer.invoke(IpcChannels.Settings.SetDeepPlanModel, model),
  },
  projects: {
    createNew: () => ipcRenderer.invoke(IpcChannels.Projects.CreateNew),
    open: () => ipcRenderer.invoke(IpcChannels.Projects.Open),
    getCurrent: () => ipcRenderer.invoke(IpcChannels.Projects.GetCurrent),
    close: () => ipcRenderer.invoke(IpcChannels.Projects.Close),
    listRecent: () => ipcRenderer.invoke(IpcChannels.Projects.ListRecent),
  },
  document: {
    read: (filename) => ipcRenderer.invoke(IpcChannels.Document.Read, filename),
    write: (filename, content) => ipcRenderer.invoke(IpcChannels.Document.Write, filename, content),
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
  documents: {
    list: () => ipcRenderer.invoke(IpcChannels.Documents.List),
    create: (name) => ipcRenderer.invoke(IpcChannels.Documents.Create, name),
    delete: (filename) => ipcRenderer.invoke(IpcChannels.Documents.Delete, filename),
  },
  chat: {
    send: (message, activeDocument, displayText) =>
      ipcRenderer.invoke(IpcChannels.Chat.Send, message, activeDocument, displayText),
    history: () => ipcRenderer.invoke(IpcChannels.Chat.History),
    clear: () => ipcRenderer.invoke(IpcChannels.Chat.Clear),
    onStarted: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.Chat.Started, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.Chat.Started, handler);
      };
    },
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
  sources: {
    ingest: (filePaths) => ipcRenderer.invoke(IpcChannels.Sources.Ingest, filePaths),
    ingestText: (text, title) => ipcRenderer.invoke(IpcChannels.Sources.IngestText, text, title),
    pickFiles: () => ipcRenderer.invoke(IpcChannels.Sources.PickFiles),
    list: () => ipcRenderer.invoke(IpcChannels.Sources.List),
    read: (slug) => ipcRenderer.invoke(IpcChannels.Sources.Read, slug),
    delete: (slug) => ipcRenderer.invoke(IpcChannels.Sources.Delete, slug),
    onChanged: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.Sources.Changed, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.Sources.Changed, handler);
      };
    },
  },
  comments: {
    list: (docFilename) => ipcRenderer.invoke(IpcChannels.Comments.List, docFilename),
    create: (docFilename, data) => ipcRenderer.invoke(IpcChannels.Comments.Create, docFilename, data),
    delete: (id) => ipcRenderer.invoke(IpcChannels.Comments.Delete, id),
    onChanged: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.Comments.Changed, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.Comments.Changed, handler);
      };
    },
  },
  pendingEdits: {
    list: (docFilename) => ipcRenderer.invoke(IpcChannels.PendingEdits.List, docFilename),
    accept: (id, override) => ipcRenderer.invoke(IpcChannels.PendingEdits.Accept, id, override),
    reject: (id) => ipcRenderer.invoke(IpcChannels.PendingEdits.Reject, id),
    patch: (docFilename, id, newString) =>
      ipcRenderer.invoke(IpcChannels.PendingEdits.Patch, docFilename, id, newString),
    clear: (docFilename) => ipcRenderer.invoke(IpcChannels.PendingEdits.Clear, docFilename),
    onChanged: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.PendingEdits.Changed, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.PendingEdits.Changed, handler);
      };
    },
  },
  wiki: {
    graph: () => ipcRenderer.invoke(IpcChannels.Wiki.Graph),
  },
  bugReport: {
    preview: (input) => ipcRenderer.invoke(IpcChannels.BugReport.Preview, input),
    submit: (input) => ipcRenderer.invoke(IpcChannels.BugReport.Submit, input),
    rendererLog: (scope, event, message) =>
      ipcRenderer.invoke(IpcChannels.BugReport.RendererLog, scope, event, message),
  },
  deepPlan: {
    status: () => ipcRenderer.invoke(IpcChannels.DeepPlan.Status),
    start: (task) => ipcRenderer.invoke(IpcChannels.DeepPlan.Start, task),
    sendMessage: (message) => ipcRenderer.invoke(IpcChannels.DeepPlan.SendMessage, message),
    advance: () => ipcRenderer.invoke(IpcChannels.DeepPlan.Advance),
    runResearch: () => ipcRenderer.invoke(IpcChannels.DeepPlan.RunResearch),
    stopResearch: () => ipcRenderer.invoke(IpcChannels.DeepPlan.StopResearch),
    addResearchHint: (hint) => ipcRenderer.invoke(IpcChannels.DeepPlan.AddResearchHint, hint),
    skip: () => ipcRenderer.invoke(IpcChannels.DeepPlan.Skip),
    oneShot: () => ipcRenderer.invoke(IpcChannels.DeepPlan.OneShot),
    reset: () => ipcRenderer.invoke(IpcChannels.DeepPlan.Reset),
    onChanged: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.DeepPlan.Changed, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.DeepPlan.Changed, handler);
      };
    },
    onChunk: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, chunk: string): void => {
        callback(chunk);
      };
      ipcRenderer.on(IpcChannels.DeepPlan.Chunk, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.DeepPlan.Chunk, handler);
      };
    },
    onChunkDone: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.DeepPlan.ChunkDone, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.DeepPlan.ChunkDone, handler);
      };
    },
    onResearchEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: DeepPlanResearchEvent,
      ): void => {
        callback(payload);
      };
      ipcRenderer.on(IpcChannels.DeepPlan.ResearchEvent, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.DeepPlan.ResearchEvent, handler);
      };
    },
  },
  deepSearch: {
    status: () => ipcRenderer.invoke(IpcChannels.DeepSearch.Status),
    start: (task) => ipcRenderer.invoke(IpcChannels.DeepSearch.Start, task),
    stop: () => ipcRenderer.invoke(IpcChannels.DeepSearch.Stop),
    addHint: (hint) => ipcRenderer.invoke(IpcChannels.DeepSearch.AddHint, hint),
    onChanged: (callback) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IpcChannels.DeepSearch.Changed, handler);
      return () => {
        ipcRenderer.removeListener(IpcChannels.DeepSearch.Changed, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('myst', api);
