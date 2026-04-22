import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import {
  DEEP_PLAN_MAX_SEARCHES_PER_ROUND,
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
import { getSummaryModel } from '../settings';
import { listSources } from '../sources';
import { runResearchEngine } from '../research/engine';
import { ensureSearchReady } from '../research/search';
import { panelistPrompt } from './prompts';
import { parsePanelOutput } from './parse';

/**
 * Panel runner. One call per phase round:
 *   1. For each role in `PANEL_ROLES_BY_PHASE[phase]`, fan out a cheap-model
 *      JSON call in parallel.
 *   2. Merge + dedupe every role's `needsResearch[]`, cap at MAX_QUERIES,
 *      dispatch through the shared research engine.
 *   3. Return structured panel outputs + list of newly-ingested source
 *      slugs to hand to the Chair.
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

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function mergeResearchRequests(
  outputs: PanelOutput[],
  cap: number,
): PanelResearchRequest[] {
  const merged: PanelResearchRequest[] = [];
  if (cap <= 0) return merged;
  const seen = new Set<string>();
  for (const out of outputs) {
    for (const req of out.needsResearch) {
      const key = normalizeQuery(req.query);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(req);
      if (merged.length >= cap) return merged;
    }
  }
  return merged;
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
  newlyIngestedSourceSlugs: string[];
  /** Count of research queries actually dispatched this round (0 when budget is exhausted or panel didn't ask). */
  searchesDispatched: number;
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
    return { role, visionNotes: '', needsResearch: [] };
  }

  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'panel.role.emptyReply', { role });
    emitProgress({ kind: 'role-done', role, findings: 0, searchQueries: 0 });
    return { role, visionNotes: '', needsResearch: [] };
  }

  const output = parsePanelOutput(reply, role);
  emitProgress({
    kind: 'role-done',
    role,
    // The renderer's progress event shape dates from the old "findings"
    // era; now that panel is vision-notes + research only, we report
    // `findings = 1` when the role emitted a non-empty vision note and
    // `0` when silent. Swap to a dedicated field later if the UI evolves.
    findings: output.visionNotes.trim().length > 0 ? 1 : 0,
    searchQueries: output.needsResearch.length,
  });
  return output;
}

/**
 * Dispatch the merged research requests through the shared engine. Returns
 * the slugs that landed in the wiki during this dispatch (used by the
 * Chair to acknowledge newly-available evidence).
 */
async function dispatchPanelResearch(
  requests: PanelResearchRequest[],
): Promise<string[]> {
  if (requests.length === 0) return [];

  try {
    await ensureSearchReady();
  } catch (err) {
    logError('deep-plan', 'panel.research.searchNotReady', err);
    return [];
  }

  emitProgress({ kind: 'research-dispatched', queries: requests.length });

  const newlyIngested: string[] = [];
  const existingSources = await listSources();
  const seen = seedSeenUrls(existingSources);

  // The engine expects a `getNextPlan` that returns one batch of
  // proposals. We already have a fixed, pre-curated list from the panel,
  // so we return it once and then return an empty array to converge.
  let served = false;
  try {
    await runResearchEngine(
      {
        runId: randomUUID(),
        source: 'deepPlan',
        getNextPlan: async () => {
          if (served) return [];
          served = true;
          return requests.map((r) => ({ query: r.query, rationale: r.rationale }));
        },
        getHints: () => [],
        isCancelled: () => false,
        onQueryComplete: async (_proposal, _queryId, ingested) => {
          for (const r of ingested) {
            // `r.url` is the original URL; the engine persists digests
            // using whatever slug the digest step produces. We can't
            // easily recover that slug here without re-reading sources,
            // so we take a snapshot after the engine finishes instead.
            void r;
          }
        },
      },
      seen,
    );
  } catch (err) {
    logError('deep-plan', 'panel.research.failed', err);
    return [];
  }

  // Diff sources list: anything present now that wasn't before is a
  // newly-ingested slug for this round.
  const afterSources = await listSources();
  const existingSlugs = new Set(existingSources.map((s) => s.slug));
  for (const s of afterSources) {
    if (!existingSlugs.has(s.slug)) newlyIngested.push(s.slug);
  }
  return newlyIngested;
}

export async function runPanelRound(args: PanelRoundArgs): Promise<PanelRoundResult> {
  const phase = args.session.phase;
  const roles = PANEL_ROLES_BY_PHASE[phase];
  if (roles.length === 0) {
    return { panelOutputs: [], newlyIngestedSourceSlugs: [], searchesDispatched: 0 };
  }

  emitProgress({ kind: 'round-start', phase, roles });

  const model = await getSummaryModel();
  const priorFindingsDigest = digestPriorFindings(args.session);
  const remainingBudget = Math.max(
    0,
    DEEP_PLAN_MAX_TOTAL_SEARCHES - args.session.searchesUsed,
  );
  const perRoundCap = Math.min(DEEP_PLAN_MAX_SEARCHES_PER_ROUND, remainingBudget);

  // Fan out all panelists in parallel. Individual failures degrade
  // gracefully to an empty output — the Chair can still synthesise
  // whatever came back.
  const panelOutputs = await Promise.all(
    roles.map((role) =>
      runOnePanelist(role, args, model, priorFindingsDigest, remainingBudget),
    ),
  );

  const researchRequests = mergeResearchRequests(panelOutputs, perRoundCap);
  const newlyIngestedSourceSlugs = await dispatchPanelResearch(researchRequests);

  log('deep-plan', 'panel.round.done', {
    phase,
    roles: roles.length,
    totalVisionNotes: panelOutputs.filter((p) => p.visionNotes.trim().length > 0).length,
    researchDispatched: researchRequests.length,
    newlyIngested: newlyIngestedSourceSlugs.length,
    remainingBudget,
  });

  return {
    panelOutputs,
    newlyIngestedSourceSlugs,
    searchesDispatched: researchRequests.length,
  };
}
