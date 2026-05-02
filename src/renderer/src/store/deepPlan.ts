import { create } from 'zustand';
import type {
  ChairAnswerMap,
  DeepPlanMode,
  DeepPlanSession,
  DeepPlanStatus,
  PanelProgressEvent,
  PanelResearchRequest,
  PanelRole,
  PanelUserPrompt,
} from '@shared/types';
import { bridge } from '../api/bridge';

/**
 * Renderer-side state for Deep Plan mode. Mirrors `DeepPlanStatus` from the
 * main process and layers on top:
 *   - `visible` — whether the full-screen view should be on screen. Driven
 *     by `shouldAutoStart` the first time, then flipped off on skip/complete.
 *   - `drafting` / `draftBuffer` — one-shot draft modal state (unchanged).
 *   - `panelProgress` — live per-role status for the in-flight round so the
 *     UI can show "Explorer thinking… Skeptic done (2)" indicators.
 */

export type PanelRoleStatus =
  | { state: 'pending' }
  | { state: 'running' }
  | {
      state: 'done';
      findings: number;
      searchQueries: number;
      /** Streamed through from the main process when the role finishes. */
      visionNotes: string;
      needsResearch: PanelResearchRequest[];
      userPrompts: PanelUserPrompt[];
    }
  | { state: 'failed'; error: string };

export interface PanelProgressState {
  roles: PanelRole[];
  byRole: Record<string, PanelRoleStatus>;
  researchDispatched: number;
  chair: 'idle' | 'running' | 'done';
}

function emptyPanelProgress(): PanelProgressState {
  return { roles: [], byRole: {}, researchDispatched: 0, chair: 'idle' };
}

interface DeepPlanState {
  visible: boolean;
  status: DeepPlanStatus | null;
  busy: boolean;
  error: string | null;
  // One-shot draft modal state.
  drafting: boolean;
  draftBuffer: string;
  panelProgress: PanelProgressState;

  refresh: () => Promise<void>;
  show: () => void;
  hide: () => void;
  start: (task: string, mode: DeepPlanMode) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  chat: (message: string) => Promise<void>;
  runPanel: () => Promise<void>;
  submitAnswers: (answers: ChairAnswerMap) => Promise<void>;
  advance: () => Promise<void>;
  skip: () => Promise<void>;
  oneShot: () => Promise<void>;
  reset: () => Promise<void>;
  ingestChunk: (chunk: string) => void;
  finishStream: () => void;
  applyPanelEvent: (event: PanelProgressEvent) => void;
  clearError: () => void;
}

export const useDeepPlan = create<DeepPlanState>((set, get) => ({
  visible: false,
  status: null,
  busy: false,
  error: null,
  drafting: false,
  draftBuffer: '',
  panelProgress: emptyPanelProgress(),

  refresh: async () => {
    try {
      const status = await bridge.deepPlan.status();
      set((prev) => ({
        status,
        visible: prev.visible || status.shouldAutoStart || status.active,
      }));
    } catch (err) {
      console.error('deepPlan.refresh failed', err);
    }
  },

  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
  clearError: () => set({ error: null }),

  start: async (task, mode) => {
    set({ busy: true, error: null, panelProgress: emptyPanelProgress() });
    try {
      const status = await bridge.deepPlan.start(task, mode);
      set({ status, visible: true });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  sendMessage: async (message) => {
    set({ busy: true, error: null });
    try {
      const status = await bridge.deepPlan.sendMessage(message);
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  chat: async (message) => {
    set({ busy: true, error: null });
    try {
      const status = await bridge.deepPlan.chat(message);
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  runPanel: async () => {
    set({ busy: true, error: null });
    try {
      const status = await bridge.deepPlan.runPanel();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  submitAnswers: async (answers) => {
    set({ busy: true, error: null });
    try {
      const status = await bridge.deepPlan.submitAnswers(answers);
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  advance: async () => {
    set({ busy: true, error: null });
    try {
      const status = await bridge.deepPlan.advance();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  skip: async () => {
    set({ busy: true, error: null });
    try {
      const status = await bridge.deepPlan.skip();
      set({ status, visible: false });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  oneShot: async () => {
    set({
      busy: true,
      error: null,
      drafting: true,
      draftBuffer: '',
    });
    try {
      const status = await bridge.deepPlan.oneShot();
      set({ status, drafting: false, draftBuffer: '', visible: false });
    } catch (err) {
      set({ error: (err as Error).message, drafting: false, draftBuffer: '' });
    } finally {
      set({ busy: false });
    }
  },

  reset: async () => {
    set({ busy: true, error: null, panelProgress: emptyPanelProgress() });
    try {
      const status = await bridge.deepPlan.reset();
      set({ status, visible: false });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  ingestChunk: (chunk) => {
    // During a one-shot draft, chunks feed the word-counter in the
    // DraftGenerationModal. The text itself is never shown in the plan UI.
    if (get().drafting) {
      set((prev) => ({ draftBuffer: prev.draftBuffer + chunk }));
    }
  },

  finishStream: () => {
    // Draft completion is handled inside `oneShot` itself.
    if (get().drafting) return;
  },

  applyPanelEvent: (event) => {
    set((prev) => {
      const progress = { ...prev.panelProgress, byRole: { ...prev.panelProgress.byRole } };
      switch (event.kind) {
        case 'round-start': {
          const byRole: Record<string, PanelRoleStatus> = {};
          for (const r of event.roles) byRole[r] = { state: 'pending' };
          return {
            panelProgress: {
              roles: event.roles,
              byRole,
              researchDispatched: 0,
              chair: 'idle',
            },
          };
        }
        case 'role-start':
          progress.byRole[event.role] = { state: 'running' };
          return { panelProgress: progress };
        case 'role-done':
          progress.byRole[event.role] = {
            state: 'done',
            findings: event.findings,
            searchQueries: event.searchQueries,
            visionNotes: event.visionNotes,
            needsResearch: event.needsResearch,
            userPrompts: event.userPrompts,
          };
          return { panelProgress: progress };
        case 'role-failed':
          progress.byRole[event.role] = { state: 'failed', error: event.error };
          return { panelProgress: progress };
        case 'research-dispatched':
          progress.researchDispatched = event.queries;
          return { panelProgress: progress };
        case 'chair-start':
          progress.chair = 'running';
          return { panelProgress: progress };
        case 'chair-done':
          progress.chair = 'done';
          return { panelProgress: progress };
        case 'round-done':
          return { panelProgress: progress };
      }
    });
  },
}));

export function latestSession(status: DeepPlanStatus | null): DeepPlanSession | null {
  return status?.session ?? null;
}
