import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type { DeepPlanResearchEvent } from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { ingestText } from '../sources';
import { jinaSearch, type JinaResult } from '../deepPlan/jina';
import type { ResearchQueryProposal } from '../deepPlan/parse';

/**
 * Generic research engine shared by Deep Plan (full planning flow) and Deep
 * Search (research-only slice). The engine owns the outer loop — propose
 * queries → run search → filter → ingest → repeat until target met, query
 * cap hit, cancelled, or planner converges — and broadcasts granular events
 * the renderer uses to animate a live graph.
 *
 * The caller is responsible for producing the next batch of queries via
 * `getNextPlan`. The engine re-calls that function between rounds, which is
 * what lets research hints "apply to the next searches not the current one":
 * any hint added mid-run is picked up on the next planner call.
 */

/** Cap queries at 20 so a pathological loop can't burn through infinite Jina calls. */
const MAX_QUERIES = 20;
/** Stop early once we've added this many sources — coverage is usually good. */
const TARGET_INGESTED = 10;
/** Hits per Jina query. */
const MAX_RESULTS_PER_QUERY = 5;
/** Cap per-query ingests so one fat query can't dominate. */
const MAX_INGEST_PER_QUERY = 3;
/** Anything shorter is almost always a cookie banner or paywall. */
const MIN_CONTENT_CHARS = 1500;

export interface ResearchEngineContext {
  runId: string;
  source: 'deepPlan' | 'deepSearch';
  jinaKey: string;

  /**
   * Produce the next batch of queries. Called once at the start of every
   * round. Returns `null` on error (engine stops with reason 'error'), or
   * an empty array to signal convergence. Receives the current list of
   * hints so the planner prompt can include them.
   */
  getNextPlan: (hints: string[]) => Promise<ResearchQueryProposal[] | null>;

  /** Fresh read each round — hints can be added mid-run. */
  getHints: () => string[];

  /** Polled between queries and ingests. Returning true stops the loop. */
  isCancelled: () => boolean;

  /** Fired when a query starts. Use to write "searching…" notes. */
  onQueryStart?: (
    proposal: ResearchQueryProposal,
    queryId: string,
  ) => Promise<void> | void;

  /** Fired when a query completes. */
  onQueryComplete?: (
    proposal: ResearchQueryProposal,
    queryId: string,
    ingested: JinaResult[],
  ) => Promise<void> | void;
}

export interface ResearchEngineResult {
  totalIngested: number;
  totalQueries: number;
  reason: 'target-reached' | 'converged' | 'cancelled' | 'query-cap' | 'error';
}

function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

function looksLikeBotBlock(text: string): boolean {
  const lower = text.toLowerCase();
  const flags = [
    'max challenge attempts',
    'please refresh the page',
    'manage consent preferences',
    'cookie preference center',
    'strictly necessary cookies',
    'you have been blocked',
    'access denied',
    'cloudflare',
    'checking your browser',
    'enable javascript',
    'are you a robot',
    'just a moment',
  ];
  let hits = 0;
  for (const f of flags) {
    if (lower.includes(f)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

function emit(ctx: ResearchEngineContext, event: DeepPlanResearchEvent): void {
  // Cancellation squelches emits so a stopped run stops painting the graph
  // the instant the user clicks — in-flight network calls may still drain
  // in the background, but the UI stays frozen at the moment of stop.
  if (ctx.isCancelled()) return;
  broadcast(IpcChannels.DeepPlan.ResearchEvent, event);
}

export async function runResearchEngine(
  ctx: ResearchEngineContext,
  seedUrls: Set<string>,
): Promise<ResearchEngineResult> {
  emit(ctx, { kind: 'run-start', runId: ctx.runId, source: ctx.source });

  const seen = seedUrls;
  let totalIngested = 0;
  let totalQueries = 0;
  let reason: ResearchEngineResult['reason'] = 'converged';

  outer: while (totalQueries < MAX_QUERIES && totalIngested < TARGET_INGESTED) {
    if (ctx.isCancelled()) {
      reason = 'cancelled';
      break;
    }

    const hints = ctx.getHints();
    const plan = await ctx.getNextPlan(hints);
    if (plan === null) {
      reason = 'error';
      break;
    }
    if (plan.length === 0) {
      reason = 'converged';
      break;
    }

    for (const proposal of plan) {
      if (ctx.isCancelled()) {
        reason = 'cancelled';
        break outer;
      }
      if (totalQueries >= MAX_QUERIES) {
        reason = 'query-cap';
        break outer;
      }
      if (totalIngested >= TARGET_INGESTED) {
        reason = 'target-reached';
        break outer;
      }

      const queryId = randomUUID();
      totalQueries++;

      emit(ctx, {
        kind: 'query-start',
        runId: ctx.runId,
        queryId,
        query: proposal.query,
        rationale: proposal.rationale,
      });
      if (ctx.onQueryStart) await ctx.onQueryStart(proposal, queryId);

      const ingested = await runOneQuery(ctx, proposal, queryId, seen);
      totalIngested += ingested.length;

      emit(ctx, {
        kind: 'query-done',
        runId: ctx.runId,
        queryId,
        ingestedCount: ingested.length,
      });
      if (ctx.onQueryComplete) await ctx.onQueryComplete(proposal, queryId, ingested);
    }
  }

  if (totalIngested >= TARGET_INGESTED && reason === 'converged') {
    reason = 'target-reached';
  }
  if (totalQueries >= MAX_QUERIES && reason === 'converged') {
    reason = 'query-cap';
  }

  emit(ctx, {
    kind: 'run-done',
    runId: ctx.runId,
    totalIngested,
    totalQueries,
    reason,
  });

  return { totalIngested, totalQueries, reason };
}

async function runOneQuery(
  ctx: ResearchEngineContext,
  proposal: ResearchQueryProposal,
  queryId: string,
  seen: Set<string>,
): Promise<JinaResult[]> {
  const resp = await jinaSearch({
    apiKey: ctx.jinaKey,
    query: proposal.query,
    maxResults: MAX_RESULTS_PER_QUERY,
  });
  if (!resp || resp.results.length === 0) return [];

  const ingested: JinaResult[] = [];
  for (const result of resp.results) {
    if (ctx.isCancelled()) break;
    if (ingested.length >= MAX_INGEST_PER_QUERY) break;

    const resultId = randomUUID();
    emit(ctx, {
      kind: 'result-seen',
      runId: ctx.runId,
      queryId,
      resultId,
      url: result.url,
      title: result.title,
    });

    const canonical = canonicalUrl(result.url);
    if (seen.has(canonical)) {
      log('research', 'dedupSkip', { url: result.url });
      emit(ctx, {
        kind: 'result-skipped',
        runId: ctx.runId,
        queryId,
        resultId,
        reason: 'duplicate',
      });
      continue;
    }

    const body = result.rawContent || result.content;
    if (!body || body.length < MIN_CONTENT_CHARS) {
      log('research', 'skipTooShort', { url: result.url, len: body?.length ?? 0 });
      emit(ctx, {
        kind: 'result-skipped',
        runId: ctx.runId,
        queryId,
        resultId,
        reason: 'too-short',
      });
      continue;
    }
    if (looksLikeBotBlock(body)) {
      log('research', 'skipBotBlock', { url: result.url });
      emit(ctx, {
        kind: 'result-skipped',
        runId: ctx.runId,
        queryId,
        resultId,
        reason: 'bot-block',
      });
      continue;
    }

    try {
      const title = `${result.title} (${new URL(result.url).hostname})`;
      const meta = await ingestText(`Source URL: ${result.url}\n\n${body}`, title);
      seen.add(canonical);
      ingested.push(result);
      emit(ctx, {
        kind: 'result-ingested',
        runId: ctx.runId,
        queryId,
        resultId,
        slug: meta.slug,
        name: meta.name,
      });
    } catch (err) {
      logError('research', 'ingestFailed', err, { url: result.url });
      emit(ctx, {
        kind: 'result-skipped',
        runId: ctx.runId,
        queryId,
        resultId,
        reason: 'ingest-failed',
      });
    }
  }
  return ingested;
}
