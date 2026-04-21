import { create } from 'zustand';
import type { DeepPlanFidelityUpdate, DeepPlanSession, DeepPlanStatus } from '@shared/types';
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
  // Draft-generation modal state. `drafting` flips to true the moment the
  // user hits "Generate Draft" and stays true until the main process
  // broadcasts ChunkDone (or oneShot resolves). `draftBuffer` accumulates
  // the streamed tokens so we can derive a live word count without
  // showing the text itself — the user wanted a quiet "generating…"
  // screen, not a text-spawn display.
  drafting: boolean;
  draftBuffer: string;
  fidelity: DeepPlanFidelityUpdate | null;

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
  ingestFidelity: (update: DeepPlanFidelityUpdate) => void;
  clearError: () => void;
}

export const useDeepPlan = create<DeepPlanState>((set, get) => ({
  visible: false,
  status: null,
  streaming: false,
  streamingBuffer: '',
  busy: false,
  error: null,
  drafting: false,
  draftBuffer: '',
  fidelity: null,

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
    // Stay visible so the DraftGenerationModal can overlay the Deep Plan
    // view while the model drafts. We hide Deep Plan only after the draft
    // lands, so the editor revealing the finished doc is the last thing
    // the user sees.
    set({
      busy: true,
      error: null,
      drafting: true,
      draftBuffer: '',
      fidelity: null,
      streaming: false,
      streamingBuffer: '',
    });
    try {
      const status = await bridge.deepPlan.oneShot();
      set({ status, drafting: false, draftBuffer: '', fidelity: null, visible: false });
    } catch (err) {
      set({ error: (err as Error).message, drafting: false, draftBuffer: '', fidelity: null });
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
    // During a one-shot draft, chunks feed the word-counter in the
    // DraftGenerationModal rather than the planner's streaming bubble.
    // We still accumulate them into a buffer so the counter can derive a
    // live word count; the text itself is never shown.
    if (get().drafting) {
      set((prev) => ({ draftBuffer: prev.draftBuffer + chunk }));
      return;
    }
    if (!get().streaming) set({ streaming: true });
    set((prev) => ({ streamingBuffer: prev.streamingBuffer + chunk }));
  },

  finishStream: () => {
    // Draft completion is handled inside `oneShot` itself — the main
    // process broadcasts ChunkDone just before the IPC call resolves, so
    // we ignore it here to avoid racing the modal down before the doc
    // write lands. Planner-chat streams still need the reset.
    if (get().drafting) return;
    set({ streaming: false, streamingBuffer: '' });
  },

  ingestFidelity: (update) => {
    set({ fidelity: update });
  },
}));

export function latestSession(status: DeepPlanStatus | null): DeepPlanSession | null {
  return status?.session ?? null;
}
