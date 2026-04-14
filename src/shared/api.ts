import type {
  AppSettings,
  ChatMessage,
  Comment,
  DeepPlanStatus,
  DocumentFile,
  PendingEdit,
  ProjectMeta,
  Result,
  SourceMeta,
  WikiGraph,
} from './types';

export interface MystApi {
  settings: {
    get: () => Promise<AppSettings>;
    setOpenRouterKey: (key: string) => Promise<void>;
    hasOpenRouterKey: () => Promise<boolean>;
    clearOpenRouterKey: () => Promise<void>;
    setDefaultModel: (model: string) => Promise<void>;
    setTavilyKey: (key: string) => Promise<void>;
    hasTavilyKey: () => Promise<boolean>;
    clearTavilyKey: () => Promise<void>;
    setDeepPlanModel: (model: string) => Promise<void>;
  };
  projects: {
    createNew: () => Promise<Result<ProjectMeta>>;
    open: () => Promise<Result<ProjectMeta>>;
    getCurrent: () => Promise<ProjectMeta | null>;
    close: () => Promise<void>;
    listRecent: () => Promise<string[]>;
  };
  document: {
    read: (filename: string) => Promise<string>;
    write: (filename: string, content: string) => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };
  documents: {
    list: () => Promise<DocumentFile[]>;
    create: (name: string) => Promise<DocumentFile>;
    delete: (filename: string) => Promise<void>;
  };
  chat: {
    send: (message: string, activeDocument: string, displayText?: string) => Promise<ChatMessage>;
    history: () => Promise<ChatMessage[]>;
    clear: () => Promise<void>;
    onStarted: (callback: () => void) => () => void;
    onChunk: (callback: (chunk: string) => void) => () => void;
    onChunkDone: (callback: () => void) => () => void;
  };
  sources: {
    ingest: (filePaths: string[]) => Promise<SourceMeta[]>;
    ingestText: (text: string, title: string) => Promise<SourceMeta>;
    pickFiles: () => Promise<string[]>;
    list: () => Promise<SourceMeta[]>;
    read: (slug: string) => Promise<string>;
    delete: (slug: string) => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };
  comments: {
    list: (docFilename: string) => Promise<Comment[]>;
    create: (
      docFilename: string,
      data: { text: string; contextBefore: string; contextAfter: string; message: string },
    ) => Promise<Comment>;
    delete: (id: string) => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };
  pendingEdits: {
    list: (docFilename: string) => Promise<PendingEdit[]>;
    accept: (id: string, override?: string) => Promise<void>;
    reject: (id: string) => Promise<void>;
    patch: (docFilename: string, id: string, newString: string) => Promise<void>;
    clear: (docFilename: string) => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };
  wiki: {
    graph: () => Promise<WikiGraph>;
  };
  bugReport: {
    submit: (input: { title: string; description: string }) => Promise<void>;
    rendererLog: (scope: string, event: string, message: string) => Promise<void>;
  };
  deepPlan: {
    status: () => Promise<DeepPlanStatus>;
    start: (task: string) => Promise<DeepPlanStatus>;
    sendMessage: (message: string) => Promise<DeepPlanStatus>;
    advance: () => Promise<DeepPlanStatus>;
    runResearch: () => Promise<DeepPlanStatus>;
    skip: () => Promise<DeepPlanStatus>;
    oneShot: () => Promise<DeepPlanStatus>;
    reset: () => Promise<DeepPlanStatus>;
    onChanged: (callback: () => void) => () => void;
    onChunk: (callback: (chunk: string) => void) => () => void;
    onChunkDone: (callback: () => void) => () => void;
  };
}
