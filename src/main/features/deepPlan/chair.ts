import { IpcChannels } from '@shared/ipc-channels';
import type {
  ChairAnswerMap,
  ChairOutput,
  DeepPlanSession,
  PanelOutput,
  SourceMeta,
} from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { completeText, type LlmMessage } from '../../llm';
import { getChairModel } from '../settings';
import { chairPrompt } from './prompts';
import { parseChairOutput } from './parse';

/**
 * Best-effort recovery when the Chair's JSON reply was truncated mid-field
 * (usually inside `visionUpdate`). We scan for the `"summary": "..."`
 * field and extract just that value so the user at least sees the Chair's
 * framing of the round. JSON.parse can't help here because the object
 * isn't balanced.
 *
 * Returns null if no recognisable summary can be found — caller falls
 * back to a generic apology in that case.
 */
function salvageSummaryFromTruncatedJson(raw: string): string | null {
  const match = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    // Re-parse the captured string literal so JSON escapes (\n, \", \\)
    // decode cleanly before we hand it to the UI.
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    const trimmed = decoded.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Chair runner post-overhaul. The Chair's output is now small: a summary,
 * an optional vision.md replacement, a list of anchor ids to append, the
 * usual question/advance/requirements fields. No plan.md rewrite, no
 * materialiser injection pass — the anchor-log append path lives in
 * `anchorLog.resolveAndAppendAnchors` and runs in the orchestrator after
 * this call returns.
 *
 * On LLM failure we return a shaped fallback so the caller has something
 * deterministic to merge into session state (summary-only, no changes).
 */
export async function runChair(args: {
  session: DeepPlanSession;
  panelOutputs: PanelOutput[];
  newlyIngestedSourceSlugs: string[];
  roundNumber: number;
  sources: SourceMeta[];
  lastAnswers: ChairAnswerMap | null;
  /** User's free-chat notes since the last panel round — steering, not overriding. */
  chatNotes: string[];
}): Promise<ChairOutput> {
  broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-start' });

  const model = await getChairModel();
  const systemPrompt = chairPrompt({
    session: args.session,
    panelOutputs: args.panelOutputs,
    newlyIngestedSourceSlugs: args.newlyIngestedSourceSlugs,
    roundNumber: args.roundNumber,
    sources: args.sources,
    lastAnswers: args.lastAnswers,
    chatNotes: args.chatNotes,
  });

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: 'Produce your JSON object now. Nothing else.',
    },
  ];

  const fallback = (summary: string, phaseAdvance = false): ChairOutput => ({
    summary,
    visionUpdate: null,
    anchorLogAdd: [],
    questions: [],
    phaseAdvance,
  });

  let reply: string | null = null;
  try {
    // Chair needs genuine output headroom — a full vision rewrite is up
    // to ~1500 words (~2k tokens), plus summary + anchor adds + questions
    // on top. A 4k default was silently truncating mid-visionUpdate,
    // which collapsed the whole JSON parse and left the user with no
    // summary + no call-to-action. 16k buys enough room even for the
    // biggest reasonable round.
    reply = await completeText({
      model,
      messages,
      logScope: 'deep-plan',
      maxTokens: 16000,
    });
  } catch (err) {
    logError('deep-plan', 'chair.failed', err);
    broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-done' });
    return fallback(
      `I hit an error synthesising the panel: ${(err as Error).message}. You can hit Continue to move on.`,
    );
  }

  broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-done' });

  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'chair.emptyReply', {});
    return fallback('The panel had nothing substantive to add this round.', true);
  }

  const parsed = parseChairOutput(reply);
  if (!parsed) {
    log('deep-plan', 'chair.parseFailed', { replyChars: reply.length });
    // Best-effort salvage: pull just the `"summary": "..."` field out of
    // the malformed JSON so the user still sees something meaningful in
    // the chair bubble. When even that fails, surface a clean apology +
    // actionable nudge rather than dumping the raw JSON blob.
    const salvaged = salvageSummaryFromTruncatedJson(reply);
    if (salvaged) {
      log('deep-plan', 'chair.parseFailed.summarySalvaged', { chars: salvaged.length });
      return fallback(
        `${salvaged}\n\n(My response got cut off before I could finish updating the vision and anchor log. Hit "Take to panel" to retry this round, or keep chatting.)`,
      );
    }
    return fallback(
      'My response came back malformed. Try "Take to panel" to retry this round, or keep chatting and I\'ll try again next round.',
    );
  }

  log('deep-plan', 'chair.done', {
    questions: parsed.questions.length,
    phaseAdvance: parsed.phaseAdvance,
    visionUpdated: parsed.visionUpdate !== null,
    visionChars: parsed.visionUpdate?.length ?? 0,
    anchorLogAddProposed: parsed.anchorLogAdd.length,
  });

  return parsed;
}
