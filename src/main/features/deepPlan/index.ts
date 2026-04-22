import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  ChairAnswerMap,
  ChairOutput,
  DeepPlanMessage,
  DeepPlanSession,
  DeepPlanStatus,
} from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { ensureLlmReady, streamChat, type LlmMessage } from '../../llm';
import { getDraftModel } from '../settings';
import { listSources } from '../sources';
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
import { oneShotPrompt } from './prompts';
import { runPanelRound } from './panel';
import { runChair } from './chair';
import { runChairChat } from './chat';
import { resolveAndAppendAnchors } from './anchorLog';
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
  extra: Partial<Pick<DeepPlanMessage, 'chair' | 'answers' | 'anchorsAddedThisRound'>> = {},
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
 *
 * Legacy path kept for any call sites that want the silent-append behaviour.
 * The default UX now routes to `chatWithChair` for actual conversation.
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
 * Free-chat with the Chair. Single cheap LLM call: record the user's
 * message, fetch a one- or two-paragraph reply from the Chair, record
 * that too. The user's message also lands in `pendingChatNotes` so the
 * next panel round (via `runPanelRoundManual` or `advancePhase`) can
 * factor it in — nothing is lost even though no panel fired here.
 *
 * This is the default send path after the initial round completes. Panels
 * are expensive; most turns are thinking out loud and don't need them.
 */
export async function chatWithChair(text: string): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  const trimmed = text.trim();
  if (!trimmed) return buildStatus();
  if (session.phase === 'done') return buildStatus();

  await requireLlm();

  // Record the user turn + accumulate for next panel round BEFORE firing
  // the Chair call, so the UI reflects it immediately and the note
  // survives even if the LLM call fails.
  await updateSession((s) => {
    const withMsg = appendMessage(s, 'user', trimmed, 'user-chat');
    return { ...withMsg, pendingChatNotes: [...s.pendingChatNotes, trimmed] };
  });
  notifyChanged();

  const sources = await listSources();
  const freshSession = await readSession();
  if (!freshSession) return buildStatus();

  const reply = await runChairChat({
    session: freshSession,
    sources,
    userMessage: trimmed,
  });

  const replyText =
    reply ??
    `I hit an error replying just now — your note is saved. Hit "Take to panel" when you're ready to pull this into a panel round.`;
  await updateSession((s) => appendMessage(s, 'assistant', replyText, 'chair-chat'));
  notifyChanged();

  return buildStatus();
}

/**
 * Explicitly trigger a panel round, consuming any `pendingChatNotes` as
 * context. UI wiring: the "Take this to panel" button next to the chat
 * input, and implicitly on phase advance via `advancePhase`.
 */
export async function runPanelRoundManual(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');
  if (roundRunning) {
    log('deep-plan', 'runPanel.rejected.roundRunning', {});
    return buildStatus();
  }
  if (session.phase === 'done') return buildStatus();

  void runPanelAndChair().catch((err) => {
    logError('deep-plan', 'panel.runPanel.failed', err);
  });
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

    // Snapshot pendingChatNotes for this round. The Chair + panel see
    // them as steering context; we clear them from session state after
    // the round so they don't bleed into the next one.
    const chatNotes = [...session.pendingChatNotes];

    const { panelOutputs, newlyIngestedSourceSlugs, searchesDispatched } = await runPanelRound({
      session,
      sources,
      lastChairSummary: lastSummary,
      lastAnswers,
      chatNotes,
    });

    // If the panel pulled in new sources, re-read the wiki so downstream
    // resolvers + the Chair see them.
    const sourcesForChair =
      newlyIngestedSourceSlugs.length > 0 ? await listSources() : sources;

    // AUTO-APPEND: every anchor the panel proposed gets resolved + pushed
    // onto the log. The Chair does NOT curate — we trust the panel. The
    // resolver dedupes against the existing log and silently drops invalid
    // ids, so dupes and hallucinations are harmless.
    const allProposedIds = new Set<string>();
    for (const p of panelOutputs) {
      for (const id of p.anchorProposals) allProposedIds.add(id);
    }
    const freshAnchors = await resolveAndAppendAnchors({
      proposals: Array.from(allProposedIds).map((id) => ({ id })),
      existingLog: session.anchorLog,
      currentPhase: session.phase,
    });

    // Push the fresh anchors to session state IMMEDIATELY — before the
    // Chair call starts. Chair can take a while (gpt-oss-120b + JSON
    // output), and users shouldn't wait for the synthesis to see the
    // evidence the panel already secured. Source ingest already
    // broadcasts mid-round; this makes anchors do the same.
    if (freshAnchors.length > 0) {
      await updateSession((s) => ({
        ...s,
        anchorLog: [...s.anchorLog, ...freshAnchors],
      }));
      notifyChanged();
    }

    // Chair sees only the NEW anchors this round (plus the round's panel
    // vision notes). No full log re-read — that's the whole token win.
    const chairOutput = await runChair({
      session,
      panelOutputs,
      newlyIngestedSourceSlugs,
      roundNumber,
      sources: sourcesForChair,
      lastAnswers,
      chatNotes,
      newAnchorsThisRound: freshAnchors,
    });

    await updateSession((s) => {
      const next = appendMessage(s, 'assistant', chairOutput.summary, 'chair-turn', {
        chair: chairOutput,
        anchorsAddedThisRound: freshAnchors.length,
      });
      const patch = chairOutput.requirementsPatch;
      const mergedRequirements = patch
        ? { ...next.requirements, ...patch }
        : next.requirements;
      const mergedVision =
        chairOutput.visionUpdate !== null ? chairOutput.visionUpdate : next.vision;
      // `anchorLog` was already appended to in the early-broadcast block
      // above, so we just carry `next.anchorLog` through — no re-append
      // here (that would duplicate).
      return {
        ...next,
        requirements: mergedRequirements,
        vision: mergedVision,
        pendingQuestions: chairOutput.questions,
        pendingChatNotes: [],
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

export async function runOneShot(): Promise<DeepPlanStatus> {
  const session = await readSession();
  if (!session) throw new Error('No Deep Plan session is active.');

  await requireLlm();
  const model = await getDraftModel();

  const docs = await listDocuments();
  if (docs.length === 0) {
    throw new Error('No document to write into. Create one from the documents panel first.');
  }
  const target = docs[0]!;

  // Phase 6: drafter sees only requirements + plan.md + prose-style guide.
  // Every anchored claim already has a verbatim blockquote materialised
  // beneath it from the Chair pass, so the wiki is not re-introduced here.
  const prompt = oneShotPrompt(session, target.label);
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
