import type { AppSettings, ChatMessage, ProjectMeta, Result } from './types';

export interface MystApi {
  settings: {
    get: () => Promise<AppSettings>;
    setOpenRouterKey: (key: string) => Promise<void>;
    hasOpenRouterKey: () => Promise<boolean>;
    clearOpenRouterKey: () => Promise<void>;
    setDefaultModel: (model: string) => Promise<void>;
  };
  projects: {
    createNew: () => Promise<Result<ProjectMeta>>;
    open: () => Promise<Result<ProjectMeta>>;
    getCurrent: () => Promise<ProjectMeta | null>;
    close: () => Promise<void>;
    listRecent: () => Promise<string[]>;
  };
  document: {
    read: () => Promise<string>;
    write: (content: string) => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };
  chat: {
    send: (message: string) => Promise<ChatMessage>;
    history: () => Promise<ChatMessage[]>;
    clear: () => Promise<void>;
    onChunk: (callback: (chunk: string) => void) => () => void;
    onChunkDone: (callback: () => void) => () => void;
  };
}
