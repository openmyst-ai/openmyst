import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  DeepPlanMessage,
  DeepPlanSession,
  DeepPlanStage,
  DeepPlanStatus,
  SourceMeta,
} from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { ensureLlmReady, streamChat, completeText, type LlmMessage } from '../../llm';
import { getDeepPlanModel } from '../settings';
import { ensureSearchReady } from '../research/search';
import { listSources, readSource } from '../sources';
import { listDocuments, writeDocument } from '../documents';
import {
  buildStatus as buildStatusBase,
  clearAutoStart,
  createSession,
  deleteSession,
  markAutoStart,
  nextStage,
  readSession,
  updateSession,
} from './state';
import {
  gapsPrompt,
  intentPrompt,
  oneShotPrompt,
  preDraftLookupPrompt,
  researchPlannerPrompt,
  scopingPrompt,
  sourcesPrompt,
  synthesisPrompt,
} from './prompts';
import { applyRubricPatch, parsePlannerReply } from './parse';
import { runResearchEngine } from '../research/engine';
import {
  formatLookupReply,
  parseSourceLookups,
  resolveSourceLookups,
} from '../sources/sourceLookup';

const MAX_LOOKUP_ROUNDS = 3;

/**
 * Cancellation flag for the currently running research loop. Flipped by
 * `stopResearch()` and checked between queries inside the engine. We keep
 * it module-level rather than per-session because there's only ever one
 * Deep Plan session at a time, and the engine reads it via a closure.
 */
let researchCancelled = false;
let researchRunning = false;

/**
 * Wrapper around the state-level buildStatus so every caller automatically
 * sees the current running flag without having to thread it through. IPC
 * handlers (including the renderer's Status call) end up here.
 */
export function buildStatus(): Promise<DeepPlanStatus> {
  return buildStatusBase(researchRunning);
}

async function streamWithLookupResolution(
  args: {
    model: string;
    messages: LlmMessage[];
  },
): Promise<string> {
  let content = await streamChat({
    model: args.model,
    messages: args.messages,
    logScope: 'deep-plan',
    onChunk: (chunk) => broadcast(IpcChannels.DeepPlan.Chunk, chunk),
  });

  for (let round = 0; round < MAX_LOOKUP_ROUNDS; round++) {
    const { requests } = parseSourceLookups(content);
    if (requests.length === 0) break;
    log('deep-plan', 'sourceLookup.round', { round, count: requests.length });
    const resolved = await resolveSourceLookups(requests);
    const followUp = formatLookupReply(resolved);
    const replayMessages: LlmMessage[] = [
      ...args.messages,
      { role: 'assistant', content },
      { role: 'user', content: followUp },
    ];
    content = await streamChat({
      model: args.model,
      messages: replayMessages,
      logScope: 'deep-plan',
      onChunk: (chunk) => broadcast(IpcChannels.DeepPlan.Chunk, chunk),
    });
  }

  // Strip any unresolved fences so they don't leak into the chat body.
  return parseSourceLookups(content).stripped || content;
}

/**
 * Deep Plan orchestration. This file is the brains:
 *   - runPlannerTurn: user sends a message in the current stage → LLM reply,
 *     streams via broadcast(Chunk), stores both messages, applies rubric
 *     patches, returns the updated status.
 *   - runResearchLoop: triggered from stage 4 → asks planner for queries,
 *     runs Jina search, ingests winning results as sources, updates counters.
 *   - runOneShot: triggered from stage 7 → calls the generator model once
 *     with the full rubric + wiki, writes the draft into the active
 *     document, marks the session complete.
 *
 * All broadcasts fire `DeepPlan.Changed` after any state mutation so the
 * renderer re-fetches status.
 */

export {
  markAutoStart,
  clearAutoStart,
  shouldAutoStart,
  deleteSession,
} from './state';

const STAGE_PROMPT_BUILDERS: Record<
  DeepPlanStage,
  ((session: DeepPlanSession, sources: SourceMeta[]) => string) | null
> = {
  intent: () => intentPrompt(),
  sources: sourcesPrompt,
  scoping: scopingPrompt,
  gaps: gapsPrompt,
  research: researchPlannerPrompt,
  synthesis: synthesisPrompt,
  handoff: null,
  done: null,
};

function notifyChanged(): void {
  broadcast(IpcChannels.DeepPlan.Changed);
}

function estimateTokensK(chars: number): number {
  // Rough: 4 chars per token → divide by 4000 to get K tokens.
  return chars / 4000;
}

function appendMessage(
  session: DeepPlanSession,
  role: DeepPlanMessage['role'],
  content: string,
  kind: DeepPlanMessage['kind'] = 'chat',
): DeepPlanSession {
  const msg: DeepPlanMessage = {
    id: randomUUID(),
    role,
    content,
    kind,
    timestamp: new Date().toISOString(),
  };
  return { ...session, messages: [...session.messages, msg] };
}

function llmHistoryFrom(session: DeepPlanSession): LlmMessage[] {
  return session.messages
    .filter((m) => m.kind === 'chat')
    .map((m) => ({
      role: m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }));
}

/**
 * Fail-fast check before kicking off a planner turn. The facade resolves the
 * actual credential (OpenRouter key or openmyst token) internally — we just
 * surface a user-friendly error if neither is available.
 */
async function requireLlm(): Promise<void> {
  await ensureLlmReady();
}

/* ------------------------------ Public API ------------------------------ */

export async function startSession(task: string): Promise<DeepPlanStatus> {
  if (!task.trim()) throw new Error('Task description cannot be empty.');
  await deleteSession();
  const session = await createSession(task);
  // Seed the conversation with an opening planner message so the user lands
  // on a populated chat column instead of a cold box.
  const opener = `Got it — "${session.task}". Drop any sources you already have into the panel on the left, and tell me if there's anything you want me to pay special attention to. Hit Continue when you're ready to scope.`;
  const withOpener = appendMessage(session, 'assistant', opener);
  const moved: DeepPlanSession = { ...withOpener, stage: 'sources' };
  await updateSession(() => moved);
  notifyChanged();
  return buildStatus();
}

export async function sendUserMessage(text: string): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  if (!text.trim()) return buildStatus();

  const builder = STAGE_PROMPT_BUILDERS[session.stage];
  if (!builder || session.stage === 'research') {
    // Terminal stages and autonomous research just record the user turn.
    await updateSession((s) => appendMessage(s, 'user', text));
    notifyChanged();
    return buildStatus();
  }

  const sources = await listSources();
  const systemPrompt = builder(session, sources);

  const withUser = appendMessage(session, 'user', text);
  await updateSession(() => withUser);
  notifyChanged();

  await requireLlm();
  const model = await getDeepPlanModel();

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    ...llmHistoryFrom(withUser),
  ];

  let fullContent = '';
  try {
    fullContent = await streamWithLookupResolution({ model, messages });
  } catch (err) {
    logError('deep-plan', 'planner.stream.failed', err);
    broadcast(IpcChannels.DeepPlan.ChunkDone);
    const errMsg = `I hit an error talking to the planner model: ${(err as Error).message}. You can try again or hit Skip.`;
    await updateSession((s) => appendMessage(s, 'assistant', errMsg));
    notifyChanged();
    return buildStatus();
  }

  broadcast(IpcChannels.DeepPlan.ChunkDone);

  const parsed = parsePlannerReply(fullContent);
  const chatBody = parsed.chat || fullContent;
  const tokenCost =
    estimateTokensK(systemPrompt.length + fullContent.length) +
    withUser.messages.reduce((sum, m) => sum + estimateTokensK(m.content.length), 0);

  await updateSession((s) => {
    let next = appendMessage(s, 'assistant', chatBody);
    if (parsed.rubricPatch) {
      next = { ...next, rubric: applyRubricPatch(next.rubric, parsed.rubricPatch) };
    }
    next = { ...next, tokensUsedK: Math.max(next.tokensUsedK, tokenCost) };
    return next;
  });

  notifyChanged();
  return buildStatus();
}

export async function advanceStage(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  const target = nextStage(session.stage);
  log('deep-plan', 'stage.advance', { from: session.stage, to: target });

  await updateSession((s) => ({
    ...s,
    stage: target,
    messages: [
      ...s.messages,
      {
        id: randomUUID(),
        role: 'system',
        content: `Moved to stage: ${target}`,
        kind: 'stage-transition',
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  notifyChanged();

  if (target === 'research') {
    // Research is fully autonomous — kick off the multi-round loop instead of
    // priming a planner chat turn.
    try {
      await runResearchLoop();
    } catch (err) {
      logError('deep-plan', 'research.autoloop.failed', err);
      await updateSession((s) =>
        appendMessage(
          s,
          'assistant',
          `Research hit an error: ${(err as Error).message}. You can hit Continue to move on.`,
        ),
      );
      notifyChanged();
    }
    return buildStatus();
  }

  // Auto-emit an opening planner message for the new stage so the user sees
  // something other than silence after hitting Continue.
  await primeStage(target);

  return buildStatus();
}

async function primeStage(stage: DeepPlanStage): Promise<void> {
  const session = await readSession();
  if (!session) return;
  const builder = STAGE_PROMPT_BUILDERS[stage];
  if (!builder) return;

  const sources = await listSources();
  const systemPrompt = builder(session, sources);
  await requireLlm();
  const model = await getDeepPlanModel();

  // The priming call reuses the full history so the model has full context,
  // but with a stage-specific opener to nudge it.
  const opener: LlmMessage = {
    role: 'user',
    content: `[stage: ${stage}] Begin this stage now. Address me directly.`,
  };

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    ...llmHistoryFrom(session),
    opener,
  ];

  let content = '';
  try {
    content = await streamWithLookupResolution({ model, messages });
  } catch (err) {
    logError('deep-plan', 'planner.prime.failed', err, { stage });
    broadcast(IpcChannels.DeepPlan.ChunkDone);
    return;
  }
  broadcast(IpcChannels.DeepPlan.ChunkDone);

  const parsed = parsePlannerReply(content);
  const chatBody = parsed.chat || content;

  await updateSession((s) => {
    let next = appendMessage(s, 'assistant', chatBody);
    if (parsed.rubricPatch) {
      next = { ...next, rubric: applyRubricPatch(next.rubric, parsed.rubricPatch) };
    }
    next = {
      ...next,
      tokensUsedK: next.tokensUsedK + estimateTokensK(systemPrompt.length + content.length),
    };
    return next;
  });
  notifyChanged();
}

export function isResearchRunning(): boolean {
  return researchRunning;
}

export function stopResearch(): void {
  if (!researchRunning) return;
  log('deep-plan', 'research.stop.requested', {});
  researchCancelled = true;
  notifyChanged();
}

export async function addResearchHint(hint: string): Promise<DeepPlanStatus> {
  const trimmed = hint.trim();
  if (!trimmed) return buildStatus();
  await updateSession((s) => ({
    ...s,
    researchHints: [...s.researchHints, trimmed],
    messages: [
      ...s.messages,
      {
        id: randomUUID(),
        role: 'user',
        content: `Steering hint: ${trimmed}`,
        kind: 'research-note',
        timestamp: new Date().toISOString(),
      },
    ],
  }));
  // The engine picks up hints on its next planner call via getHints().
  notifyChanged();
  return buildStatus();
}

export async function runResearchLoop(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  if (session.stage !== 'research') {
    log('deep-plan', 'research.skipNotInStage', { stage: session.stage });
    return buildStatus();
  }
  if (researchRunning) {
    log('deep-plan', 'research.alreadyRunning', {});
    return buildStatus();
  }

  try {
    await ensureSearchReady();
  } catch (err) {
    await updateSession((s) =>
      appendMessage(
        s,
        'assistant',
        `I can't run autonomous research right now: ${(err as Error).message} You can hit Continue without it to skip ahead.`,
      ),
    );
    notifyChanged();
    return buildStatus();
  }

  await requireLlm();
  const model = await getDeepPlanModel();

  notifyChanged();

  // Seed the dedup set with URLs for every source already in the wiki, so
  // re-runs don't re-ingest the same page the planner happens to surface
  // again. The engine mutates it as new sources land.
  const seenUrls = new Set<string>();
  {
    const existing = await listSources();
    for (const src of existing) {
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
  }

  researchCancelled = false;
  researchRunning = true;
  notifyChanged();
  let tokensThisLoop = 0;
  const runId = randomUUID();

  try {
    const result = await runResearchEngine(
      {
        runId,
        source: 'deepPlan',
        getHints: () => {
          // Read fresh from disk so hints added while the loop is running
          // get picked up on the next planner call.
          return (session.researchHints ?? []).slice();
        },
        isCancelled: () => researchCancelled,
        getNextPlan: async (hints) => {
          const current = await readSession();
          if (!current) return null;
          const sources = await listSources();
          // Pull latest hints from disk each round so mid-run additions land.
          const latestHints = current.researchHints ?? hints;
          const plannerSystem = researchPlannerPrompt(current, sources, latestHints);
          const rawPlan = await completeText({
            model,
            messages: [
              { role: 'system', content: plannerSystem },
              { role: 'user', content: 'Propose the next queries now.' },
            ],
            logScope: 'deep-plan',
          });
          if (rawPlan === null) {
            log('deep-plan', 'research.planner.nullReply', {});
            return null;
          }
          tokensThisLoop += estimateTokensK(plannerSystem.length + rawPlan.length);
          return parsePlannerReply(rawPlan).researchPlan ?? [];
        },
        onQueryStart: async () => {
          // Per-query chat notes are intentionally suppressed — the live
          // status bar + research graph already show what the agent is
          // doing, so echoing it into the chat log was just noise.
        },
        onQueryComplete: async (proposal, _queryId, ingested) => {
          tokensThisLoop += estimateTokensK(
            ingested.reduce(
              (sum, r) => sum + r.content.length + (r.rawContent?.length ?? 0),
              0,
            ),
          );
          await updateSession((s) => {
            const record = {
              query: proposal.query,
              rationale: proposal.rationale,
              resultsSeen: ingested.length,
              ingestedSlugs: ingested.map((r) => r.url),
              timestamp: new Date().toISOString(),
            };
            return {
              ...s,
              researchQueries: [...s.researchQueries, record],
            };
          });
          notifyChanged();
        },
      },
      seenUrls,
    );

    // Research is not a conversation — the graph + source counter tell
    // the user what happened. Appending a "Coverage looks good…" chat
    // message here leaks across stages and shows up as a stray bubble
    // in later stages, so we only keep the token accounting.
    log('deep-plan', 'research.loop.done', {
      reason: result.reason,
      totalIngested: result.totalIngested,
      totalQueries: result.totalQueries,
    });
    await updateSession((s) => ({
      ...s,
      tokensUsedK: s.tokensUsedK + tokensThisLoop,
    }));
  } finally {
    researchRunning = false;
    researchCancelled = false;
    notifyChanged();
  }

  return buildStatus();
}

export async function skipSession(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (session) {
    await updateSession((s) => ({ ...s, skipped: true, stage: 'done' }));
  }
  await clearAutoStart();
  notifyChanged();
  return buildStatus();
}

export async function resetSession(): Promise<DeepPlanStatus> {
  await deleteSession();
  await clearAutoStart();
  notifyChanged();
  return buildStatus();
}

/**
 * Read the detailed wiki-style summary (`sources/<slug>.md`) for each
 * source. This is what the drafter actually needs — a 2-4 paragraph read
 * of each source, not just the one-liner `indexSummary`. If a `.md` file
 * is missing (rare — happens for raw-file sources that only stub the
 * summary), we fall back to the source's indexSummary via the map miss
 * in `richSourcesBlock`.
 */
async function loadDetailedSummaries(
  sources: SourceMeta[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    sources.map(async (s) => {
      try {
        const body = await readSource(s.slug);
        if (body.trim().length > 0) out.set(s.slug, body);
      } catch {
        // missing .md — leave the map entry empty; richSourcesBlock falls
        // back to indexSummary for that slug.
      }
    }),
  );
  return out;
}

/**
 * Synthesise the planning conversation into a block the drafter can read.
 * The session holds every chat message across all stages; the drafter
 * doesn't need the full transcript, just the sharpened decisions. We keep:
 *   - every user turn (concise, usually states what they want)
 *   - the planner's last few assistant turns (scoping / gaps / clarify /
 *     review synthesis — the review stage in particular is the planner's
 *     own "here's what I'm about to write" pitch, which is gold)
 * Anything tagged as a structured fence is already stripped by the
 * planner loop before it lands in the transcript.
 */
function buildPlannerSynthesis(session: DeepPlanSession): string {
  const chat = session.messages.filter((m) => m.kind === 'chat');
  const userTurns = chat
    .filter((m) => m.role === 'user')
    .map((m) => `- ${m.content.trim()}`)
    .filter((l) => l.length > 2);
  const recentPlanner = chat
    .filter((m) => m.role === 'assistant')
    .slice(-4)
    .map((m) => m.content.trim())
    .filter((c) => c.length > 0);

  const parts: string[] = [];
  if (userTurns.length > 0) {
    parts.push(`User decisions and steering:\n${userTurns.join('\n')}`);
  }
  if (recentPlanner.length > 0) {
    parts.push(
      `Planner's recent synthesis (ending with its handoff summary):\n\n${recentPlanner.join('\n\n---\n\n')}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Compact summary of the research phase — what queries ran and what got
 * ingested. The detailed summaries of each ingested source are already in
 * the main wiki block, so this is just context on how they got there and
 * any user steering hints that shaped the search.
 */
function buildResearchSummary(session: DeepPlanSession): string {
  const queries = session.researchQueries;
  const hints = session.researchHints;
  if (queries.length === 0 && hints.length === 0) return '';
  const lines: string[] = [];
  if (queries.length > 0) {
    lines.push(
      `Queries run (${queries.length}):\n` +
        queries
          .map(
            (q) =>
              `- "${q.query}" → ${q.ingestedSlugs.length} ingested${
                q.ingestedSlugs.length > 0 ? ` (${q.ingestedSlugs.join(', ')})` : ''
              }`,
          )
          .join('\n'),
    );
  }
  if (hints.length > 0) {
    lines.push(`User steering hints:\n${hints.map((h) => `- ${h}`).join('\n')}`);
  }
  return lines.join('\n\n');
}

/**
 * One-shot pre-draft pass. Asks the model which verbatim anchors / source
 * pages it wants pulled before the actual draft call. Non-streaming —
 * we only care about the source_lookup fences it emits. Any prose the
 * model accidentally adds is discarded; if no lookups come back, we
 * return an empty string and the drafter runs with summaries alone.
 *
 * Failures (missing LLM, malformed output) degrade silently to "no
 * prefetch" rather than blocking the draft — the drafter always has
 * the detailed summaries to fall back on.
 */
async function runPreDraftLookups(args: {
  model: string;
  session: DeepPlanSession;
  sources: SourceMeta[];
  detailedSummaries: Map<string, string>;
  plannerSynthesis: string;
  researchSummary: string;
  docLabel: string;
}): Promise<string> {
  const prompt = preDraftLookupPrompt(
    args.session,
    args.sources,
    args.detailedSummaries,
    args.plannerSynthesis,
    args.researchSummary,
    args.docLabel,
  );
  const messages: LlmMessage[] = [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content:
        'Emit source_lookup fences only — no prose. If nothing worth pulling, emit nothing.',
    },
  ];

  let reply: string | null = null;
  try {
    reply = await completeText({ model: args.model, messages, logScope: 'deep-plan' });
  } catch (err) {
    logError('deep-plan', 'oneshot.preDraft.failed', err);
    return '';
  }
  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'oneshot.preDraft.empty', {});
    return '';
  }

  const { requests } = parseSourceLookups(reply);
  if (requests.length === 0) {
    log('deep-plan', 'oneshot.preDraft.noLookups', { replyChars: reply.length });
    return '';
  }
  log('deep-plan', 'oneshot.preDraft.requests', {
    count: requests.length,
    slugs: requests.map((r) => r.slug),
  });

  const resolved = await resolveSourceLookups(requests);
  const formatted = formatLookupReply(resolved);
  log('deep-plan', 'oneshot.preDraft.resolved', {
    count: resolved.length,
    chars: formatted.length,
  });
  return formatted;
}

export async function runOneShot(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');

  await requireLlm();
  const model = await getDeepPlanModel();
  const sources = await listSources();

  // Pick the active document — for a new project there's only one, created
  // during scaffolding. If somehow there are multiple, take the first.
  const docs = await listDocuments();
  if (docs.length === 0) {
    throw new Error('No document to write into. Create one from the documents panel first.');
  }
  const target = docs[0]!;

  const detailedSummaries = await loadDetailedSummaries(sources);
  const plannerSynthesis = buildPlannerSynthesis(session);
  const researchSummary = buildResearchSummary(session);

  // Pre-draft lookup pass. One non-streaming LLM call that reads the same
  // context as the drafter and emits source_lookup fences for any verbatim
  // anchors / pages / raw files it wants pre-fetched. We resolve them off
  // disk and hand the formatted results to the draft prompt so the actual
  // draft call stays a single clean stream.
  const prefetchedPassages = await runPreDraftLookups({
    model,
    session,
    sources,
    detailedSummaries,
    plannerSynthesis,
    researchSummary,
    docLabel: target.label,
  });

  const prompt = oneShotPrompt(
    session,
    sources,
    detailedSummaries,
    plannerSynthesis,
    researchSummary,
    prefetchedPassages,
    target.label,
  );
  const messages: LlmMessage[] = [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content:
        'Write the full draft now. Output only the markdown of the draft itself — no preamble.',
    },
  ];

  log('deep-plan', 'oneshot.start', {
    doc: target.filename,
    model,
    sources: sources.length,
    detailed: detailedSummaries.size,
    promptChars: prompt.length,
  });

  // We deliberately do NOT stream into the document. The renderer shows a
  // dedicated "generating…" modal driven by DeepPlan.Chunk broadcasts
  // (used only for the live word counter), and the finished draft lands
  // in the doc in one write at the end. Streaming into the file produced
  // a distracting "text spawning" effect the user didn't want.
  let fullContent = '';
  try {
    fullContent = await streamChat({
      model,
      messages,
      logScope: 'deep-plan',
      onChunk: (chunk) => broadcast(IpcChannels.DeepPlan.Chunk, chunk),
    });
  } catch (err) {
    logError('deep-plan', 'oneshot.failed', err);
    broadcast(IpcChannels.DeepPlan.ChunkDone);
    throw err;
  }

  broadcast(IpcChannels.DeepPlan.ChunkDone);

  const draft = fullContent.trim();
  if (draft.length === 0) {
    throw new Error('The generator returned an empty draft. Try again.');
  }

  await writeDocument(target.filename, draft);

  await updateSession((s) => ({
    ...s,
    stage: 'done',
    completed: true,
    tokensUsedK: s.tokensUsedK + estimateTokensK(prompt.length + fullContent.length),
  }));
  await clearAutoStart();
  broadcast(IpcChannels.Document.Changed);
  notifyChanged();
  return buildStatus();
}
