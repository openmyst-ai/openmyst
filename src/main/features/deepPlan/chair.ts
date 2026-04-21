import { IpcChannels } from '@shared/ipc-channels';
import type {
  ChairOutput,
  DeepPlanSession,
  PanelOutput,
} from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { completeText, type LlmMessage } from '../../llm';
import { getDeepPlanModel } from '../settings';
import { chairPrompt } from './prompts';
import { parseChairOutput } from './parse';

/**
 * Strong-model Chair call. Consumes the panel's structured findings,
 * emits a JSON object `{summary, questions, phaseAdvance, rubricPatch}`
 * that the renderer splits into a chat bubble + Question Card carousel.
 *
 * On parse failure we fall back to a minimal ChairOutput with the raw
 * text as summary and no questions, so the user always sees *something*
 * rather than a frozen UI.
 */
export async function runChair(args: {
  session: DeepPlanSession;
  panelOutputs: PanelOutput[];
  newlyIngestedSourceSlugs: string[];
  roundNumber: number;
}): Promise<ChairOutput> {
  broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-start' });

  const model = await getDeepPlanModel();
  const systemPrompt = chairPrompt({
    session: args.session,
    panelOutputs: args.panelOutputs,
    newlyIngestedSourceSlugs: args.newlyIngestedSourceSlugs,
    roundNumber: args.roundNumber,
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
    logError('deep-plan', 'chair.failed', err);
    broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-done' });
    return {
      summary: `I hit an error synthesising the panel: ${(err as Error).message}. You can hit Continue to move on.`,
      questions: [],
      phaseAdvance: false,
    };
  }

  broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-done' });

  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'chair.emptyReply', {});
    return {
      summary: 'The panel had nothing substantive to add this round.',
      questions: [],
      phaseAdvance: true,
    };
  }

  const parsed = parseChairOutput(reply);
  if (!parsed) {
    log('deep-plan', 'chair.parseFailed', { replyChars: reply.length });
    return {
      summary: reply.trim().slice(0, 500),
      questions: [],
      phaseAdvance: false,
    };
  }

  log('deep-plan', 'chair.done', {
    questions: parsed.questions.length,
    phaseAdvance: parsed.phaseAdvance,
    hasRubricPatch: Boolean(parsed.rubricPatch),
  });

  return parsed;
}
