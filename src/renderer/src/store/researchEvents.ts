import { create } from 'zustand';
import type { DeepPlanResearchEvent } from '@shared/types';

/**
 * Shared event log for live research runs. Both Deep Plan (inside its
 * research stage) and Deep Search (inside its modal) subscribe to the same
 * stream coming off `deepPlan.onResearchEvent`. Each event carries a
 * `runId` so consumers can filter to the run they care about.
 *
 * The store keeps the last N events in memory — enough to rebuild the graph
 * from a cold mount — and exposes a helper to reset when a new run begins.
 */

const MAX_EVENTS = 500;

interface ResearchEventsState {
  events: DeepPlanResearchEvent[];
  currentRunId: string | null;
  push: (event: DeepPlanResearchEvent) => void;
  reset: () => void;
}

export const useResearchEvents = create<ResearchEventsState>((set) => ({
  events: [],
  currentRunId: null,
  push: (event) =>
    set((prev) => {
      if (event.kind === 'run-start') {
        return { events: [event], currentRunId: event.runId };
      }
      const nextEvents = [...prev.events, event];
      const trimmed =
        nextEvents.length > MAX_EVENTS
          ? nextEvents.slice(nextEvents.length - MAX_EVENTS)
          : nextEvents;
      return { events: trimmed };
    }),
  reset: () => set({ events: [], currentRunId: null }),
}));
