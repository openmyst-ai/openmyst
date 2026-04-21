import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  ChairAnswerMap,
  ChairOutput,
  DeepPlanMessage,
  DeepPlanSession,
  DeepPlanStatus,
  SourceMeta,
} from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { ensureLlmReady, streamChat, completeText, type LlmMessage } from '../../llm';
import { getDeepPlanModel } from '../settings';
import { listSources, readSource } from '../sources';
import { listDocuments, writeDocument } from '../documents';
import {
  buildStatus as buildStatusBase,
  clearAutoStart,
  createSession,
  deleteSession,
  nextPhase,
  readSession,
  updateSession,
} from './state';
import { oneShotPrompt, preDraftLookupPrompt } from './prompts';
import { runPanelRound } from './panel';
import { runChair } from './chair';
import {
  formatLookupReply,
  parseSourceLookups,
  resolveSourceLookups,
} from '../sources/sourceLookup';

/**
 * Deep Plan orchestrator. The flow is now:
 *   ideation → planning → reviewing → done
 *
 * Each non-done phase runs an inner loop:
 *   1. Panel round (cheap-model fanout, optional research dispatch)
 *   2. Chair synthesis (strong model) → summary + questions
 *   3. User answers → next round, OR Continue → next phase
 *
 * The one-shot drafter is unchanged and runs at the reviewing → done
 * handoff.
 */

const MAX_LOOKUP_ROUNDS = 3;

/**
 * Set while a panel round (including any triggered research) is in
 * flight. Module-level because there's only ever one Deep Plan session
 * at a time.
 */
let roundRunning = false;

export function buildStatus(): Promise<DeepPlanStatus> {
  return buildStatusBase(roundRunning);
}

export {
  markAutoStart,
  clearAutoStart,
  shouldAutoStart,
  deleteSession,
} from './state';

function notifyChanged(): void {
  broadcast(IpcChannels.DeepPlan.Changed);
}

function estimateTokensK(chars: number): number {
  return chars / 4000;
}

function appendMessage(
  session: DeepPlanSession,
  role: DeepPlanMessage['role'],
  content: string,
  kind: DeepPlanMessage['kind'] = 'chat',
  extra: Partial<Pick<DeepPlanMessage, 'chair' | 'answers'>> = {},
): DeepPlanSession {
  const msg: DeepPlanMessage = {
    id: randomUUID(),
    role,
    content,
    kind,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  return { ...session, messages: [...session.messages, msg] };
}

async function requireLlm(): Promise<void> {
  await ensureLlmReady();
}

function lastChairTurn(session: DeepPlanSession): {
  summary: string | null;
  output: ChairOutput | null;
} {
  const lastChair = [...session.messages]
    .reverse()
    .find((m) => m.kind === 'chair-turn' && m.chair);
  if (!lastChair || !lastChair.chair) return { summary: null, output: null };
  return { summary: lastChair.chair.summary, output: lastChair.chair };
}

function lastUserAnswers(session: DeepPlanSession): ChairAnswerMap | null {
  const lastAnswers = [...session.messages]
    .reverse()
    .find((m) => m.kind === 'user-answers' && m.answers);
  return lastAnswers?.answers ?? null;
}

/* ------------------------------ Public API ------------------------------ */

export async function startSession(task: string): Promise<DeepPlanStatus> {
  if (!task.trim()) throw new Error('Task description cannot be empty.');
  await deleteSession();
  await createSession(task);
  notifyChanged();
  // Fire the first panel round immediately — no opener chat message, the
  // Chair's first summary is the opener.
  void runPanelAndChair().catch((err) => {
    logError('deep-plan', 'panel.start.failed', err);
  });
  return buildStatus();
}

/**
 * Free-text user turn. Stored as a plain chat message so the next panel
 * round can see it in the transcript. Does not trigger a round on its own
 * — the user hits Continue or submits answers to drive forward.
 */
export async function sendUserMessage(text: string): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  if (!text.trim()) return buildStatus();
  await updateSession((s) => appendMessage(s, 'user', text));
  notifyChanged();
  return buildStatus();
}

/**
 * User submitted answers to the Chair's pending questions. Record them,
 * clear the pending-questions slot, and fire the next panel round.
 */
export async function submitAnswers(answers: ChairAnswerMap): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  if (roundRunning) {
    log('deep-plan', 'submitAnswers.rejected.roundRunning', {});
    return buildStatus();
  }

  await updateSession((s) => {
    const withAnswers = appendMessage(
      s,
      'user',
      'User answered the Chair.',
      'user-answers',
      { answers },
    );
    return { ...withAnswers, pendingQuestions: [] };
  });
  notifyChanged();

  void runPanelAndChair().catch((err) => {
    logError('deep-plan', 'panel.submitAnswers.failed', err);
  });
  return buildStatus();
}

/**
 * Force-advance to the next phase. Records a phase-transition marker and
 * fires an opening round in the new phase. If we're already on `reviewing`
 * → `done`, caller should use `runOneShot` instead (this function will
 * still advance the phase but skip firing a panel in 'done').
 */
export async function advancePhase(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  const target = nextPhase(session.phase);
  log('deep-plan', 'phase.advance', { from: session.phase, to: target });

  await updateSession((s) => {
    const withTransition = appendMessage(
      s,
      'system',
      `Moved to phase: ${target}`,
      'phase-transition',
    );
    return { ...withTransition, phase: target, pendingQuestions: [] };
  });
  notifyChanged();

  if (target === 'done') return buildStatus();

  void runPanelAndChair().catch((err) => {
    logError('deep-plan', 'panel.advance.failed', err);
  });
  return buildStatus();
}

export async function skipSession(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (session) {
    await updateSession((s) => ({ ...s, skipped: true, phase: 'done' }));
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

export function isRoundRunning(): boolean {
  return roundRunning;
}

/* ----------------------- Panel + Chair inner loop ----------------------- */

async function runPanelAndChair(): Promise<void> {
  if (roundRunning) {
    log('deep-plan', 'panel.alreadyRunning', {});
    return;
  }
  const session = await readSession();
  if (!session) return;
  if (session.phase === 'done') return;

  await requireLlm();

  roundRunning = true;
  notifyChanged();

  try {
    const sources = await listSources();
    const { summary: lastSummary } = lastChairTurn(session);
    const lastAnswers = lastUserAnswers(session);
    const roundNumber = (session.roundsPerPhase[session.phase] ?? 0) + 1;

    const { panelOutputs, newlyIngestedSourceSlugs, searchesDispatched } = await runPanelRound({
      session,
      sources,
      lastChairSummary: lastSummary,
      lastAnswers,
    });

    // If the panel pulled in new sources, re-read the wiki so the Chair
    // sees them when rewriting the plan.
    const sourcesForChair =
      newlyIngestedSourceSlugs.length > 0 ? await listSources() : sources;

    const chairOutput = await runChair({
      session,
      panelOutputs,
      newlyIngestedSourceSlugs,
      roundNumber,
      sources: sourcesForChair,
      lastAnswers,
    });

    await updateSession((s) => {
      const next = appendMessage(s, 'assistant', chairOutput.summary, 'chair-turn', {
        chair: chairOutput,
      });
      // Fold the Chair's requirements patch into session.requirements so
      // the next round's prompt sees the user's answers to "what word
      // count?" / "what form?" / "who's the audience?" as specified.
      // Without this, the Chair would re-ask those same questions every
      // round because missingRequirements() only looks at session state.
      const patch = chairOutput.requirementsPatch;
      const mergedRequirements = patch
        ? { ...next.requirements, ...patch }
        : next.requirements;
      return {
        ...next,
        requirements: mergedRequirements,
        plan: chairOutput.plan || next.plan,
        pendingQuestions: chairOutput.questions,
        searchesUsed: next.searchesUsed + searchesDispatched,
        roundsPerPhase: {
          ...next.roundsPerPhase,
          [next.phase]: (next.roundsPerPhase[next.phase] ?? 0) + 1,
        },
      };
    });

    broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'round-done' });
    notifyChanged();
  } catch (err) {
    logError('deep-plan', 'panel.loop.failed', err);
    await updateSession((s) =>
      appendMessage(
        s,
        'assistant',
        `Panel round hit an error: ${(err as Error).message}. Hit Continue to move on.`,
      ),
    );
    notifyChanged();
  } finally {
    roundRunning = false;
    notifyChanged();
  }
}

/* ---------------------------- One-shot drafter ---------------------------- */

async function streamWithLookupResolution(args: {
  model: string;
  messages: LlmMessage[];
}): Promise<string> {
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

  return parseSourceLookups(content).stripped || content;
}

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
        // missing .md — fall back to indexSummary via richSourcesBlock.
      }
    }),
  );
  return out;
}

async function runPreDraftLookups(args: {
  model: string;
  session: DeepPlanSession;
  sources: SourceMeta[];
  detailedSummaries: Map<string, string>;
  docLabel: string;
}): Promise<string> {
  const prompt = preDraftLookupPrompt(
    args.session,
    args.sources,
    args.detailedSummaries,
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

  const docs = await listDocuments();
  if (docs.length === 0) {
    throw new Error('No document to write into. Create one from the documents panel first.');
  }
  const target = docs[0]!;

  const detailedSummaries = await loadDetailedSummaries(sources);

  const prefetchedPassages = await runPreDraftLookups({
    model,
    session,
    sources,
    detailedSummaries,
    docLabel: target.label,
  });

  const prompt = oneShotPrompt(
    session,
    sources,
    detailedSummaries,
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

  let fullContent = '';
  try {
    fullContent = await streamWithLookupResolution({ model, messages });
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
    phase: 'done',
    completed: true,
    tokensUsedK: s.tokensUsedK + estimateTokensK(prompt.length + fullContent.length),
  }));
  await clearAutoStart();
  broadcast(IpcChannels.Document.Changed);
  notifyChanged();
  return buildStatus();
}
