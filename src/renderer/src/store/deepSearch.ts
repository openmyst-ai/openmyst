import { create } from 'zustand';
import type { DeepSearchStatus } from '@shared/types';
import { bridge } from '../api/bridge';

/**
 * Renderer-side state for Deep Search — the "pop into research mode"
 * modal that lives alongside the editor. Unlike Deep Plan, Deep Search is
 * ephemeral: the main process holds all authoritative state in memory,
 * and this store mirrors it for the UI.
 */

interface DeepSearchState {
  visible: boolean;
  status: DeepSearchStatus | null;
  error: string | null;

  open: () => void;
  close: () => void;
  refresh: () => Promise<void>;
  start: (task: string) => Promise<void>;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
  addHint: (hint: string) => Promise<void>;
  clearError: () => void;
}

export const useDeepSearch = create<DeepSearchState>((set) => ({
  visible: false,
  status: null,
  error: null,

  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
  clearError: () => set({ error: null }),

  refresh: async () => {
    try {
      const status = await bridge.deepSearch.status();
      set({ status });
    } catch (err) {
      console.error('deepSearch.refresh failed', err);
    }
  },

  start: async (task) => {
    set({ error: null });
    try {
      const status = await bridge.deepSearch.start(task);
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  stop: async () => {
    try {
      const status = await bridge.deepSearch.stop();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  reset: async () => {
    set({ error: null });
    try {
      const status = await bridge.deepSearch.reset();
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  addHint: async (hint) => {
    try {
      const status = await bridge.deepSearch.addHint(hint);
      set({ status });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
}));
