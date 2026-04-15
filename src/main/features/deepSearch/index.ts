import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type { DeepSearchQueryRecord, DeepSearchStatus } from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { completeText } from '../../llm';
import { getDeepPlanModel, getJinaKey, getOpenRouterKey } from '../settings';
import { listSources } from '../sources';
import { deepSearchPlannerPrompt } from '../deepPlan/prompts';
import { parsePlannerReply } from '../deepPlan/parse';
import { runResearchEngine } from '../research/engine';

/**
 * Deep Search — the "pop into research mode" slice. It shares the research
 * engine with Deep Plan but is ephemeral: there's no session file, no rubric,
 * no writing stage. A project only ever has one Deep Search run in flight at
 * a time; state lives in memory and is broadcast to the renderer whenever it
 * mutates.
 *
 * The run lifecycle:
 *   1. `start(task)` — kicks off a new run in the background (fire-and-forget
 *      so the IPC call returns immediately). Flips `running` on.
 *   2. `stop()` — flips the cancellation flag; the engine bails between
 *      queries and then resolves.
 *   3. `addHint(hint)` — appends a steering hint; the engine picks it up on
 *      the next planner call.
 */

interface DeepSearchState {
  running: boolean;
  runId: string | null;
  task: string | null;
  hints: string[];
  queries: DeepSearchQueryRecord[];
  totalIngested: number;
  lastError: string | null;
  updatedAt: string;
  cancelled: boolean;
}

function freshState(): DeepSearchState {
  return {
    running: false,
    runId: null,
    task: null,
    hints: [],
    queries: [],
    totalIngested: 0,
    lastError: null,
    updatedAt: new Date().toISOString(),
    cancelled: false,
  };
}

let state: DeepSearchState = freshState();

function touch(): void {
  state.updatedAt = new Date().toISOString();
  broadcast(IpcChannels.DeepSearch.Changed);
}

export function getStatus(): DeepSearchStatus {
  return {
    running: state.running,
    runId: state.runId,
    task: state.task,
    hints: state.hints.slice(),
    queries: state.queries.slice(),
    totalIngested: state.totalIngested,
    lastError: state.lastError,
    updatedAt: state.updatedAt,
  };
}

export function stopSearch(): DeepSearchStatus {
  if (!state.running) return getStatus();
  log('deep-search', 'stop.requested', {});
  state.cancelled = true;
  touch();
  return getStatus();
}

export function addHint(hint: string): DeepSearchStatus {
  const trimmed = hint.trim();
  if (!trimmed) return getStatus();
  state.hints = [...state.hints, trimmed];
  touch();
  return getStatus();
}

export async function startSearch(task: string): Promise<DeepSearchStatus> {
  const trimmed = task.trim();
  if (!trimmed) throw new Error('Research task cannot be empty.');
  if (state.running) {
    throw new Error('Deep Search is already running. Stop it first.');
  }

  const jinaKey = await getJinaKey();
  if (!jinaKey) {
    throw new Error('Jina API key not set. Open Settings and add one.');
  }
  const openRouterKey = await getOpenRouterKey();
  if (!openRouterKey) {
    throw new Error('OpenRouter API key not set. Open Settings and add one.');
  }
  const model = await getDeepPlanModel();

  // Reset state for a new run.
  state = {
    ...freshState(),
    running: true,
    runId: randomUUID(),
    task: trimmed,
  };
  touch();

  // Seed dedup set with existing wiki URLs.
  const seenUrls = new Set<string>();
  for (const src of await listSources()) {
    if (src.sourcePath) {
      try {
        const u = new URL(src.sourcePath);
        u.hash = '';
        let path = u.pathname.replace(/\/+$/, '');
        if (path === '') path = '/';
        seenUrls.add(`${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`);
      } catch {
        seenUrls.add(src.sourcePath.trim().toLowerCase());
      }
    }
  }

  // Fire-and-forget: the engine runs in the background, state mutates live,
  // and `running` flips off in the finally block. The IPC caller gets the
  // initial running status back immediately.
  void (async () => {
    try {
      await runResearchEngine(
        {
          runId: state.runId!,
          source: 'deepSearch',
          jinaKey,
          getHints: () => state.hints.slice(),
          isCancelled: () => state.cancelled,
          getNextPlan: async (hints) => {
            const sources = await listSources();
            const priorQueries = state.queries.map((q) => q.query);
            const prompt = deepSearchPlannerPrompt(trimmed, sources, priorQueries, hints);
            const raw = await completeText({
              apiKey: openRouterKey,
              model,
              messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: 'Propose the next queries now.' },
              ],
              logScope: 'deep-search',
            });
            if (raw === null) {
              log('deep-search', 'planner.nullReply', {});
              return null;
            }
            return parsePlannerReply(raw).researchPlan ?? [];
          },
          onQueryComplete: async (proposal, queryId, ingested) => {
            state.queries = [
              ...state.queries,
              {
                queryId,
                query: proposal.query,
                rationale: proposal.rationale,
                ingestedCount: ingested.length,
                timestamp: new Date().toISOString(),
              },
            ];
            state.totalIngested += ingested.length;
            touch();
          },
        },
        seenUrls,
      );
    } catch (err) {
      logError('deep-search', 'run.failed', err);
      state.lastError = (err as Error).message;
    } finally {
      state.running = false;
      state.cancelled = false;
      touch();
    }
  })();

  return getStatus();
}
