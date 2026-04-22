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
import { getDeepPlanModel } from '../settings';
import { chairPrompt } from './prompts';
import { parseChairOutput } from './parse';
import { applyPlanPatch, countCitations, materialiseAnchors } from './materialise';

/**
 * Strong-model Chair call. Consumes the panel's structured findings and
 * the current plan.md, emits a JSON object `{summary, plan, questions,
 * phaseAdvance}` where `plan` is the full rewritten plan.md.
 *
 * On parse failure we preserve the prior plan and surface the raw reply as
 * the summary so the user sees *something* rather than a frozen UI.
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

  const model = await getDeepPlanModel();
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

  let reply: string | null = null;
  try {
    reply = await completeText({ model, messages, logScope: 'deep-plan' });
  } catch (err) {
    logError('deep-plan', 'chair.failed', err);
    broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-done' });
    return {
      summary: `I hit an error synthesising the panel: ${(err as Error).message}. You can hit Continue to move on.`,
      plan: args.session.plan,
      questions: [],
      phaseAdvance: false,
    };
  }

  broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-done' });

  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'chair.emptyReply', {});
    return {
      summary: 'The panel had nothing substantive to add this round.',
      plan: args.session.plan,
      questions: [],
      phaseAdvance: true,
    };
  }

  const parsed = parseChairOutput(reply);
  if (!parsed) {
    log('deep-plan', 'chair.parseFailed', { replyChars: reply.length });
    return {
      summary: reply.trim().slice(0, 500),
      plan: args.session.plan,
      questions: [],
      phaseAdvance: false,
    };
  }

  // Lever 2: if the Chair emitted a `planPatch`, apply it to the prior
  // plan instead of swallowing a full rewrite. This saves massive output
  // tokens on mature plans where only a claim or two actually changed.
  // Full-plan `plan` field still wins when present AND non-empty —
  // that's the safe fallback for rounds where the Chair wants to
  // restructure broadly.
  let patchStats: { applied: number; skipped: number } | null = null;
  let rawPlan: string;
  if (parsed.plan.trim()) {
    rawPlan = parsed.plan;
  } else if (parsed.planPatch) {
    const result = applyPlanPatch(args.session.plan, parsed.planPatch);
    rawPlan = result.plan;
    patchStats = { applied: result.applied, skipped: result.skipped };
  } else {
    rawPlan = args.session.plan;
  }

  // Phase 5: materialise every `([Name](slug.md#anchor-id))` citation into
  // a verbatim blockquote pulled from the source index. The Chair only
  // emits markers — we inject the evidence deterministically so plan.md
  // becomes a self-contained handoff artefact for the drafter. The lint
  // count is just logged; no hard gate yet.
  const {
    plan: planOut,
    silentlyUnanchored,
    needsAnchor,
    materialised,
    hallucinatedAnchors,
  } = await materialiseAnchors(rawPlan, args.sources);

  // Continuity check — if the new plan has FEWER citations than the prior
  // one, the Chair dropped committed groundings. Logged loud so prompt
  // regressions show up as a visible signal, not silent data loss.
  const priorCitations = countCitations(args.session.plan);
  const newCitations = countCitations(planOut);
  const droppedCitations = Math.max(0, priorCitations - newCitations);

  log('deep-plan', 'chair.done', {
    questions: parsed.questions.length,
    phaseAdvance: parsed.phaseAdvance,
    planChars: planOut.length,
    anchorsMaterialised: materialised,
    hallucinatedAnchors,
    needsAnchorMarkers: needsAnchor,
    silentlyUnanchored,
    priorCitations,
    newCitations,
    droppedCitations,
    patchMode: patchStats !== null,
    patchApplied: patchStats?.applied ?? 0,
    patchSkipped: patchStats?.skipped ?? 0,
  });

  return { ...parsed, plan: planOut };
}
