import { useEffect, useRef, useState } from 'react';
import type { DeepPlanResearchEvent } from '@shared/types';

/**
 * Walks the events log newest-first within the current run and returns the
 * most recent query text so the floating "Researching… <query>" pill always
 * reflects whatever the engine just fired. Bails on `run-start` so text from
 * a previous run can't leak through into the next one.
 */
export function latestQueryText(events: DeepPlanResearchEvent[]): string | null {
  let runId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (!runId && 'runId' in ev) runId = ev.runId;
    if (ev.kind === 'run-start') return null;
    if ('runId' in ev && ev.runId !== runId) break;
    if (ev.kind === 'query-start') return ev.query;
  }
  return null;
}

/**
 * True while the engine is mid-run — the most recent run-start has not yet
 * been matched by a run-done for the same runId. Used to decide whether to
 * show the floating "Researching…" pill above the graph.
 */
export function researchRunningFromEvents(events: DeepPlanResearchEvent[]): boolean {
  let activeRunId: string | null = null;
  for (const ev of events) {
    if (ev.kind === 'run-start') activeRunId = ev.runId;
    else if (ev.kind === 'run-done' && ev.runId === activeRunId) activeRunId = null;
  }
  return activeRunId !== null;
}

/**
 * Flashes the current query text for a few seconds whenever it changes, so
 * queries visibly chain through the pill instead of the text silently
 * swapping. Returns null between flashes — the caller collapses the pill
 * down to just "Researching…" when nothing is flashing.
 */
export function useQueryFlash(query: string | null, durationMs = 3500): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  const lastSeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!query) return;
    if (query === lastSeenRef.current) return;
    lastSeenRef.current = query;
    setFlash(query);
    const t = window.setTimeout(() => setFlash(null), durationMs);
    return () => window.clearTimeout(t);
  }, [query, durationMs]);
  return flash;
}
