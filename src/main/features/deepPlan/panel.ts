import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import {
  DEEP_PLAN_MAX_TOTAL_SEARCHES,
  PANEL_ROLES_BY_PHASE,
  type ChairAnswerMap,
  type DeepPlanSession,
  type PanelOutput,
  type PanelProgressEvent,
  type PanelResearchRequest,
  type PanelRole,
  type SourceMeta,
} from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { completeText, type LlmMessage } from '../../llm';
import { getPanelModel } from '../settings';
import { listSources } from '../sources';
import { runResearchEngine } from '../research/engine';
import { ensureSearchReady } from '../research/search';
import { panelistPrompt } from './prompts';
import { parsePanelOutput } from './parse';

export interface DelegatedSearch {
  query: string;
  rationale: string;
}

/**
 * Panel runner. One call per phase round:
 *   1. For each role in `PANEL_ROLES_BY_PHASE[phase]`, fan out a cheap-model
 *      JSON call in parallel.
 *   2. Return each panelist's vision notes + user-prompts (concerns /
 *      questions / clarifications / ideas) for the Chair to synthesise.
 *
 * Search is no longer dispatched here — it's user-gated. Panelists propose
 * research as `delegableQuery` riding on their user-prompts; the
 * orchestrator dispatches when the user picks the "research this" answer
 * option in `submitAnswers`.
 *
 * All progress events broadcast on `DeepPlan.PanelProgress` so the UI can
 * animate per-role status dots.
 */

function emitProgress(event: PanelProgressEvent): void {
  broadcast(IpcChannels.DeepPlan.PanelProgress, event);
}

function digestPriorFindings(session: DeepPlanSession, limit = 12): string {
  // Walk back through chat messages for user-answers + chair-turns that
  // carry the previous-round findings context. We don't persist raw
  // panel outputs on disk — the digest here is built from what the Chair
  // chose to expose. The goal is only to prevent re-raising the same
  // points, so a compact list of prior Chair summaries is sufficient.
  const chairTurns = session.messages
    .filter((m) => m.kind === 'chair-turn' && m.chair)
    .slice(-3);
  if (chairTurns.length === 0) return '';
  return chairTurns
    .map((m, i) => `- prior summary ${i + 1}: "${m.chair!.summary}"`)
    .slice(0, limit)
    .join('\n');
}

export interface PanelRoundArgs {
  session: DeepPlanSession;
  sources: SourceMeta[];
  lastChairSummary: string | null;
  lastAnswers: ChairAnswerMap | null;
  /**
   * User's free-chat notes accumulated since the last panel round. Injected
   * into the panel + Chair prompts as "points the user raised in chat" so
   * the round factors them in. Cleared on the session side after the round.
   */
  chatNotes?: string[];
}

export interface PanelRoundResult {
  panelOutputs: PanelOutput[];
  /** Slugs of sources auto-dispatched + ingested by this round's `needsResearch`. */
  newlyIngestedSourceSlugs: string[];
  /** Count of auto-dispatched searches (excludes user-gated `delegableQuery` ones). */
  autoSearchesDispatched: number;
}

async function runOnePanelist(
  role: PanelRole,
  args: PanelRoundArgs,
  model: string,
  priorFindingsDigest: string,
  remainingSearchBudget: number,
): Promise<PanelOutput> {
  emitProgress({ kind: 'role-start', role });

  const systemPrompt = panelistPrompt(role, {
    session: args.session,
    sources: args.sources,
    lastChairSummary: args.lastChairSummary,
    lastAnswers: args.lastAnswers,
    priorFindingsDigest,
    remainingSearchBudget,
    chatNotes: args.chatNotes ?? [],
  });

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: 'Produce your JSON object now. Nothing else.',
    },
  ];

  let reply: string | null = null;
  try {
    reply = await completeText({ model, messages, logScope: 'deep-plan' });
  } catch (err) {
    logError('deep-plan', 'panel.role.failed', err, { role });
    emitProgress({ kind: 'role-failed', role, error: (err as Error).message });
    return { role, visionNotes: '', userPrompts: [], needsResearch: [] };
  }

  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'panel.role.emptyReply', { role });
    emitProgress({
      kind: 'role-done',
      role,
      findings: 0,
      searchQueries: 0,
      visionNotes: '',
      needsResearch: [],
      userPrompts: [],
    });
    return { role, visionNotes: '', userPrompts: [], needsResearch: [] };
  }

  const output = parsePanelOutput(reply, role);
  // searchQueries surfaced live = auto-fires + delegable proposals. The UI
  // shows it as "N searches lined up" so the user sees activity ahead of
  // time. The `needsResearch` payload mirrors auto-fire queries (they're
  // about to run); delegable queries appear separately on userPrompts.
  const delegableCount = output.userPrompts.filter((p) => p.delegableQuery).length;
  const searchQueries = output.needsResearch.length + delegableCount;
  emitProgress({
    kind: 'role-done',
    role,
    findings: output.visionNotes.trim().length > 0 ? 1 : 0,
    searchQueries,
    visionNotes: output.visionNotes,
    needsResearch: output.needsResearch,
    userPrompts: output.userPrompts,
  });
  return output;
}

function normalizeQueryKey(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function mergeAutoResearch(
  outputs: PanelOutput[],
  cap: number,
): PanelResearchRequest[] {
  if (cap <= 0) return [];
  const merged: PanelResearchRequest[] = [];
  const seen = new Set<string>();
  for (const out of outputs) {
    for (const req of out.needsResearch) {
      const key = normalizeQueryKey(req.query);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(req);
      if (merged.length >= cap) return merged;
    }
  }
  return merged;
}

export async function runPanelRound(args: PanelRoundArgs): Promise<PanelRoundResult> {
  const phase = args.session.phase;
  const roles = PANEL_ROLES_BY_PHASE[phase];
  if (roles.length === 0) {
    return { panelOutputs: [], newlyIngestedSourceSlugs: [], autoSearchesDispatched: 0 };
  }

  emitProgress({ kind: 'round-start', phase, roles });

  const model = await getPanelModel();
  const priorFindingsDigest = digestPriorFindings(args.session);
  const remainingBudget = Math.max(
    0,
    DEEP_PLAN_MAX_TOTAL_SEARCHES - args.session.searchesUsed,
  );
  // No per-round artificial cap — panelists self-regulate via the
  // soft-target prompt. Only the session-wide budget gates dispatch.
  const perRoundCap = remainingBudget;

  // Run panelists with a concurrency cap. Each phase has at most 4 roles
  // (ideation 3, planning 4, reviewing 4), so a cap of 5 effectively runs
  // the whole phase in parallel — fastest path when backend rate limits
  // have headroom.
  const PANEL_CONCURRENCY = 5;
  const panelOutputs: PanelOutput[] = [];
  for (let i = 0; i < roles.length; i += PANEL_CONCURRENCY) {
    const batch = roles.slice(i, i + PANEL_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((role) =>
        runOnePanelist(role, args, model, priorFindingsDigest, remainingBudget),
      ),
    );
    panelOutputs.push(...batchResults);
  }

  // Auto-dispatch the panel's `needsResearch` lane. These are queries the
  // panel decided fire regardless of user input — bounded by the per-round
  // cap so we don't blow the search budget when multiple panelists pile on.
  // The user-gated `delegableQuery` lane runs separately, in `submitAnswers`.
  const autoSearches = mergeAutoResearch(panelOutputs, perRoundCap);
  let newlyIngestedSourceSlugs: string[] = [];
  if (autoSearches.length > 0) {
    const { newlyIngestedSlugs } = await dispatchDelegatedSearches(autoSearches);
    newlyIngestedSourceSlugs = newlyIngestedSlugs;
  }

  log('deep-plan', 'panel.round.done', {
    phase,
    roles: roles.length,
    totalVisionNotes: panelOutputs.filter((p) => p.visionNotes.trim().length > 0).length,
    totalUserPrompts: panelOutputs.reduce((sum, p) => sum + p.userPrompts.length, 0),
    autoSearches: autoSearches.length,
    delegableQueries: panelOutputs.reduce(
      (sum, p) => sum + p.userPrompts.filter((u) => u.delegableQuery).length,
      0,
    ),
    newlyIngested: newlyIngestedSourceSlugs.length,
    remainingBudget,
  });

  return {
    panelOutputs,
    newlyIngestedSourceSlugs,
    autoSearchesDispatched: autoSearches.length,
  };
}

function seedSeenUrls(sources: SourceMeta[]): Set<string> {
  const seen = new Set<string>();
  for (const src of sources) {
    if (!src.sourcePath) continue;
    try {
      const u = new URL(src.sourcePath);
      u.hash = '';
      let path = u.pathname.replace(/\/+$/, '');
      if (path === '') path = '/';
      seen.add(`${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`);
    } catch {
      seen.add(src.sourcePath.trim().toLowerCase());
    }
  }
  return seen;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Dispatch a list of user-delegated research queries through the shared
 * engine. Called from the orchestrator after `submitAnswers` detects the
 * `DELEGATE_TO_RESEARCH` sentinel on questions with `delegableQuery` —
 * not from the panel itself, since search is no longer autonomous.
 *
 * Returns `{ slugs, dispatched }` so the caller can credit
 * `searchesUsed` and pass new sources to the Chair.
 */
export async function dispatchDelegatedSearches(
  queries: DelegatedSearch[],
): Promise<{ newlyIngestedSlugs: string[]; dispatched: number }> {
  const dedup: DelegatedSearch[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const key = normalizeQuery(q.query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(q);
  }
  if (dedup.length === 0) return { newlyIngestedSlugs: [], dispatched: 0 };

  try {
    await ensureSearchReady();
  } catch (err) {
    logError('deep-plan', 'delegated.search.notReady', err);
    return { newlyIngestedSlugs: [], dispatched: 0 };
  }

  emitProgress({ kind: 'research-dispatched', queries: dedup.length });

  const existingSources = await listSources();
  const seenUrls = seedSeenUrls(existingSources);
  let served = false;
  try {
    await runResearchEngine(
      {
        runId: randomUUID(),
        source: 'deepPlan',
        getNextPlan: async () => {
          if (served) return [];
          served = true;
          return dedup.map((r) => ({ query: r.query, rationale: r.rationale }));
        },
        getHints: () => [],
        isCancelled: () => false,
        onQueryComplete: async () => {
          /* no-op — we diff sources after the engine returns */
        },
      },
      seenUrls,
    );
  } catch (err) {
    logError('deep-plan', 'delegated.search.failed', err);
    return { newlyIngestedSlugs: [], dispatched: dedup.length };
  }

  const after = await listSources();
  const existingSlugs = new Set(existingSources.map((s) => s.slug));
  const newlyIngestedSlugs = after.filter((s) => !existingSlugs.has(s.slug)).map((s) => s.slug);
  log('deep-plan', 'delegated.search.done', {
    dispatched: dedup.length,
    newlyIngested: newlyIngestedSlugs.length,
  });
  return { newlyIngestedSlugs, dispatched: dedup.length };
}
