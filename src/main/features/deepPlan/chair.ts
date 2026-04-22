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
    reply = await completeText({ model, messages, logScope: 'deep-plan' });
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
    return fallback(reply.trim().slice(0, 500));
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
