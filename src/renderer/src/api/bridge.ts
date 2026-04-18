import type { MystApi } from '@shared/api';

const EXPECTED_NAMESPACES = [
  'auth',
  'me',
  'settings',
  'projects',
  'workspace',
  'document',
  'documents',
  'chat',
  'sources',
  'comments',
  'pendingEdits',
  'wiki',
  'bugReport',
  'deepPlan',
  'deepSearch',
  'updater',
] as const;

function getApi(): MystApi {
  const api = window.myst as Partial<MystApi> | undefined;
  if (!api) {
    throw new Error(
      'Preload bridge not initialized (window.myst is undefined). ' +
        'The preload script did not run — check the main process logs.',
    );
  }
  for (const ns of EXPECTED_NAMESPACES) {
    if (!(ns in api)) {
      throw new Error(
        `Preload bridge is stale: missing "${ns}" namespace. ` +
          'Fully stop and restart `npm run dev` — Electron only loads the preload ' +
          'script once, so Vite HMR does not pick up changes to it.',
      );
    }
  }
  return api as MystApi;
}

export const bridge: MystApi = {
  get auth() {
    return getApi().auth;
  },
  get me() {
    return getApi().me;
  },
  get settings() {
    return getApi().settings;
  },
  get projects() {
    return getApi().projects;
  },
  get workspace() {
    return getApi().workspace;
  },
  get document() {
    return getApi().document;
  },
  get documents() {
    return getApi().documents;
  },
  get chat() {
    return getApi().chat;
  },
  get sources() {
    return getApi().sources;
  },
  get comments() {
    return getApi().comments;
  },
  get pendingEdits() {
    return getApi().pendingEdits;
  },
  get wiki() {
    return getApi().wiki;
  },
  get bugReport() {
    return getApi().bugReport;
  },
  get deepPlan() {
    return getApi().deepPlan;
  },
  get deepSearch() {
    return getApi().deepSearch;
  },
  get updater() {
    return getApi().updater;
  },
} as MystApi;
