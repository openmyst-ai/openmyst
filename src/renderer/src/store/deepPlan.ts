import { create } from 'zustand';
import type { DeepPlanSession, DeepPlanStatus } from '@shared/types';
import { bridge } from '../api/bridge';

/**
 * Renderer-side state for Deep Plan mode. Mirrors `DeepPlanStatus` from the
 * main process and layers on top:
 *   - `visible` — whether the full-screen view should be on screen. Driven by
 *     `shouldAutoStart` the first time, then flipped off on skip/complete.
 *   - `streaming` — true while the planner's token stream is in flight, so
 *     the UI can show a placeholder bubble.
 *   - `streamingBuffer` — accumulates tokens from `onChunk` until `onChunkDone`.
 */

interface DeepPlanState {
  visible: boolean;
  status: DeepPlanStatus | null;
  streaming: boolean;
  streamingBuffer: string;
  busy: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  show: () => void;
  hide: () => void;
  start: (task: string) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  advance: () => Promise<void>;
  runResearch: () => Promise<void>;
  stopResearch: () => Promise<void>;
  addResearchHint: (hint: string) => Promise<void>;
  skip: () => Promise<void>;
  oneShot: () => Promise<void>;
  reset: () => Promise<void>;
  ingestChunk: (chunk: string) => void;
  finishStream: () => void;
  clearError: () => void;
}

export const useDeepPlan = create<DeepPlanState>((set, get) => ({
  visible: false,
  status: null,
  streaming: false,
  streamingBuffer: '',
  busy: false,
  error: null,

  refresh: async () => {
    try {
      const status = await bridge.deepPlan.status();
      set((prev) => ({
        status,
        // Auto-show on first load if the project is freshly created.
        visible: prev.visible || status.shouldAutoStart || status.active,
      }));
    } catch (err) {
      console.error('deepPlan.refresh failed', err);
    }
  },

  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
  clearError: () => set({ error: null }),

  start: async (task) => {
    set({ busy: true, error: null });
    try {
      const status = await bridge.deepPlan.start(task);
      set({ status, visible: true });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  sendMessage: async (message) => {
    set({ busy: true, error: null, streaming: true, streamingBuffer: '' });
    try {
      const status = await bridge.deepPlan.sendMessage(message);
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false, streaming: false, streamingBuffer: '' });
    }
  },

  advance: async () => {
    set({ busy: true, error: null, streaming: true, streamingBuffer: '' });
    try {
      const status = await bridge.deepPlan.advance();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false, streaming: false, streamingBuffer: '' });
    }
  },

  runResearch: async () => {
    // Don't block the UI on the long-running research call — research is
    // cancellable now, so the user needs to keep interacting with the store
    // (stop, addHint) while the engine is churning.
    set({ error: null });
    try {
      const status = await bridge.deepPlan.runResearch();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  stopResearch: async () => {
    try {
      const status = await bridge.deepPlan.stopResearch();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  addResearchHint: async (hint) => {
    try {
      const status = await bridge.deepPlan.addResearchHint(hint);
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
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
    // Hide Deep Plan immediately so the user sees the draft land in the main
    // editor live instead of watching it stream inside the planner view.
    set({ busy: true, error: null, visible: false });
    try {
      const status = await bridge.deepPlan.oneShot();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  reset: async () => {
    set({ busy: true, error: null });
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
    if (!get().streaming) set({ streaming: true });
    set((prev) => ({ streamingBuffer: prev.streamingBuffer + chunk }));
  },

  finishStream: () => {
    set({ streaming: false, streamingBuffer: '' });
  },
}));

export function latestSession(status: DeepPlanStatus | null): DeepPlanSession | null {
  return status?.session ?? null;
}
