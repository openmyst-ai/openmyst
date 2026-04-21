import type {
  AppSettings,
  ChairAnswerMap,
  ChatMessage,
  Comment,
  DeepPlanResearchEvent,
  DeepPlanStatus,
  DeepSearchStatus,
  DocumentFile,
  MeStatus,
  PanelProgressEvent,
  PendingEdit,
  ProjectMeta,
  Result,
  SourceAnchor,
  SourceMeta,
  UpdateStatus,
  WikiGraph,
  WorkspaceProject,
} from './types';

export interface AuthStatus {
  signedIn: boolean;
}

export interface MystApi {
  auth: {
    status: () => Promise<AuthStatus>;
    signIn: () => Promise<{ loginUrl: string }>;
    pasteToken: (token: string) => Promise<void>;
    signOut: () => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };
  me: {
    get: () => Promise<MeStatus>;
    refresh: () => Promise<MeStatus>;
    onChanged: (callback: () => void) => () => void;
  };
  settings: {
    get: () => Promise<AppSettings>;
    setOpenRouterKey: (key: string) => Promise<void>;
    hasOpenRouterKey: () => Promise<boolean>;
    clearOpenRouterKey: () => Promise<void>;
    setDefaultModel: (model: string) => Promise<void>;
    setJinaKey: (key: string) => Promise<void>;
    hasJinaKey: () => Promise<boolean>;
    clearJinaKey: () => Promise<void>;
    setDeepPlanModel: (model: string) => Promise<void>;
    setSummaryModel: (model: string) => Promise<void>;
  };
  projects: {
    createNew: () => Promise<Result<ProjectMeta>>;
    open: () => Promise<Result<ProjectMeta>>;
    getCurrent: () => Promise<ProjectMeta | null>;
    close: () => Promise<void>;
    listRecent: () => Promise<string[]>;
    createByName: (input: { name: string; parentDir?: string }) => Promise<Result<ProjectMeta>>;
    openByPath: (path: string) => Promise<Result<ProjectMeta>>;
  };
  workspace: {
    getRoot: () => Promise<string | null>;
    pickRoot: () => Promise<string | null>;
    setRoot: (path: string) => Promise<string>;
    listProjects: () => Promise<WorkspaceProject[]>;
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
    ingestLink: (url: string) => Promise<SourceMeta>;
    pickFiles: () => Promise<string[]>;
    list: () => Promise<SourceMeta[]>;
    read: (slug: string) => Promise<string>;
    lookupAnchor: (
      slug: string,
      anchorId: string,
    ) => Promise<{ slug: string; anchor: SourceAnchor; text: string } | null>;
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
    preview: (input: { title: string; description: string }) => Promise<{
      title: string;
      body: string;
      deliveryMode: 'worker' | 'browser';
    }>;
    submit: (input: { title: string; description: string }) => Promise<{
      issueUrl: string;
      issueNumber: number | null;
      delivered: 'worker' | 'browser';
      workerError?: string;
    }>;
    rendererLog: (scope: string, event: string, message: string) => Promise<void>;
  };
  deepPlan: {
    status: () => Promise<DeepPlanStatus>;
    start: (task: string) => Promise<DeepPlanStatus>;
    sendMessage: (message: string) => Promise<DeepPlanStatus>;
    submitAnswers: (answers: ChairAnswerMap) => Promise<DeepPlanStatus>;
    advance: () => Promise<DeepPlanStatus>;
    skip: () => Promise<DeepPlanStatus>;
    oneShot: () => Promise<DeepPlanStatus>;
    reset: () => Promise<DeepPlanStatus>;
    onChanged: (callback: () => void) => () => void;
    onChunk: (callback: (chunk: string) => void) => () => void;
    onChunkDone: (callback: () => void) => () => void;
    onResearchEvent: (callback: (event: DeepPlanResearchEvent) => void) => () => void;
    onPanelProgress: (callback: (event: PanelProgressEvent) => void) => () => void;
  };
  deepSearch: {
    status: () => Promise<DeepSearchStatus>;
    start: (task: string) => Promise<DeepSearchStatus>;
    stop: () => Promise<DeepSearchStatus>;
    reset: () => Promise<DeepSearchStatus>;
    addHint: (hint: string) => Promise<DeepSearchStatus>;
    onChanged: (callback: () => void) => () => void;
  };
  updater: {
    getStatus: () => Promise<UpdateStatus>;
    check: () => Promise<UpdateStatus>;
    downloadAndInstall: () => Promise<UpdateStatus>;
    onChanged: (callback: () => void) => () => void;
  };
}
