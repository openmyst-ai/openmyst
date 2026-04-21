import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type { DeepSearchQueryRecord, DeepSearchStatus } from '@shared/types';
import { broadcast, log, logError, projectRoot } from '../../platform';
import { completeText, ensureLlmReady } from '../../llm';
import { getDeepPlanModel } from '../settings';
import { listSources } from '../sources';
import { deepSearchPlannerPrompt } from '../deepPlan/prompts';
import { parseResearchPlan } from '../deepPlan/parse';
import { readSession as readDeepPlanSession } from '../deepPlan/state';
import { runResearchEngine } from '../research/engine';
import { ensureSearchReady } from '../research/search';
import { clearState, readState, writeState } from './state';

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
  /**
   * Path of the project this in-memory state belongs to. `getStatus` checks
   * this against the currently open project so re-opening a different
   * project pulls its persisted state instead of showing the previous one.
   */
  projectPath: string | null;
}

function freshState(projectPath: string | null = null): DeepSearchState {
  return {
    running: false,
    runId: null,
    task: null,
    hints: [],
    queries: [],
    totalIngested: 0,
    lastError: null,
    updatedAt: new Date().toISOString(),
    projectPath,
  };
}

/**
 * Per-run handle. Cancellation is tracked here instead of on the top-level
 * state so that "stop" on an old run doesn't bleed into a fresh run started
 * before the old engine's finally has fired — each run owns its own flag and
 * the finally only touches state when its run is still the active one.
 */
interface ActiveRun {
  runId: string;
  cancelled: boolean;
}

let state: DeepSearchState = freshState();
let activeRun: ActiveRun | null = null;

function currentProjectRootOrNull(): string | null {
  try {
    return projectRoot();
  } catch {
    return null;
  }
}

function persistCurrent(): void {
  // Don't persist to disk while the state still belongs to a different
  // project — that would blow away the target project's real state. This
  // is only reached between `ensureHydrated` sync paths; real writes go
  // through the async touch path below.
  const root = currentProjectRootOrNull();
  if (!root || root !== state.projectPath) return;
  void writeState({
    task: state.task,
    queries: state.queries.slice(),
    totalIngested: state.totalIngested,
    hints: state.hints.slice(),
    lastError: state.lastError,
    updatedAt: state.updatedAt,
  }).catch((err) => logError('deep-search', 'state.write.failed', err));
}

function touch(): void {
  state.updatedAt = new Date().toISOString();
  persistCurrent();
  broadcast(IpcChannels.DeepSearch.Changed);
}

/**
 * Bind the in-memory state to the currently open project, reading any
 * persisted queries/hints/task from disk. A no-op if we're already bound
 * to this project, or if an active run is mid-flight (switching projects
 * under a live run isn't supported and shouldn't happen from the UI).
 */
async function hydrateForCurrentProject(): Promise<void> {
  const root = currentProjectRootOrNull();
  if (!root) return;
  if (state.projectPath === root) return;
  if (activeRun) return;
  const persisted = await readState().catch((err) => {
    logError('deep-search', 'state.read.failed', err);
    return null;
  });
  state = {
    ...freshState(root),
    task: persisted?.task ?? null,
    queries: persisted?.queries.slice() ?? [],
    totalIngested: persisted?.totalIngested ?? 0,
    hints: persisted?.hints.slice() ?? [],
    lastError: persisted?.lastError ?? null,
    updatedAt: persisted?.updatedAt ?? new Date().toISOString(),
  };
}

export async function getStatus(): Promise<DeepSearchStatus> {
  await hydrateForCurrentProject();
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

export async function stopSearch(): Promise<DeepSearchStatus> {
  if (!state.running) return getStatus();
  log('deep-search', 'stop.requested', {});
  if (activeRun) activeRun.cancelled = true;
  // Flip running off immediately so the UI updates on click instead of
  // waiting for the in-flight planner/search/ingest to drain. The engine
  // notices cancellation between awaits and bails shortly after; any
  // straggling events are squelched by the cancellation-guarded emit.
  state.running = false;
  touch();
  return getStatus();
}

export async function resetSearch(): Promise<DeepSearchStatus> {
  if (state.running) {
    throw new Error('Stop the current run before resetting.');
  }
  state = freshState(currentProjectRootOrNull());
  await clearState().catch((err) => logError('deep-search', 'state.clear.failed', err));
  touch();
  return getStatus();
}

export async function addHint(hint: string): Promise<DeepSearchStatus> {
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

  await hydrateForCurrentProject();
  await ensureLlmReady();
  await ensureSearchReady();
  const model = await getDeepPlanModel();

  // Reset state for a new run — wipes any prior queries from previous runs
  // in this project so the "queries tried so far" list reflects only this
  // run's exploration.
  const runId = randomUUID();
  const run: ActiveRun = { runId, cancelled: false };
  activeRun = run;
  state = {
    ...freshState(currentProjectRootOrNull()),
    running: true,
    runId,
    task: trimmed,
  };
  await clearState().catch((err) => logError('deep-search', 'state.clear.failed', err));
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
  //
  // The finally block only writes when `run` is still the active run —
  // otherwise a stopped-then-restarted sequence would let the old engine's
  // late finally clobber the new run's state.
  void (async () => {
    try {
      await runResearchEngine(
        {
          runId,
          source: 'deepSearch',
          getHints: () => state.hints.slice(),
          isCancelled: () => run.cancelled,
          getNextPlan: async (hints) => {
            if (run.cancelled) return [];
            const sources = await listSources();
            const priorQueries = state.queries.map((q) => q.query);
            // Pull the Deep Plan requirements fresh each loop so the planner
            // stays aligned with any updates the user made mid-run.
            const dpSession = await readDeepPlanSession().catch(() => null);
            const requirements =
              dpSession && !dpSession.skipped ? dpSession.requirements : null;
            const prompt = deepSearchPlannerPrompt(
              trimmed,
              sources,
              priorQueries,
              hints,
              requirements,
            );
            const raw = await completeText({
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
            return parseResearchPlan(raw) ?? [];
          },
          onQueryComplete: async (proposal, queryId, ingested) => {
            if (run.cancelled) return;
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
      if (activeRun === run) {
        state.lastError = (err as Error).message;
      }
    } finally {
      if (activeRun === run) {
        activeRun = null;
        state.running = false;
        touch();
      }
    }
  })();

  return getStatus();
}
