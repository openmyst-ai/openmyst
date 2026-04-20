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
      const nextEvents = [...prev.events, event];
      const trimmed =
        nextEvents.length > MAX_EVENTS
          ? nextEvents.slice(nextEvents.length - MAX_EVENTS)
          : nextEvents;
      const patch: Partial<ResearchEventsState> = { events: trimmed };
      // run-start still updates currentRunId so the per-run helpers
      // (freshSlugsFromEvents, pendingNodesFromEvents) can rescope their
      // walks — but we no longer wipe the event log. "Continue
      // researching" is meant to extend the existing log, not erase it.
      if (event.kind === 'run-start') patch.currentRunId = event.runId;
      return patch as ResearchEventsState;
    }),
  reset: () => set({ events: [], currentRunId: null }),
}));
