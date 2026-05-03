import { IpcChannels } from '@shared/ipc-channels';
import type {
  AnchorLogEntry,
  ChairAnswerMap,
  ChairOutput,
  ChairQuestion,
  DeepPlanSession,
  PanelOutput,
  PlanRequirements,
  SourceMeta,
} from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { completeText, type LlmMessage } from '../../llm';
import { getChairModel } from '../settings';
import { chairPrompt } from './prompts';
import { parseChairOutput } from './parse';

/**
 * Hard-coded requirements-probe questions. When the Chair fails outright
 * (empty reply, parse failure) AND the session's hard requirements aren't
 * fully specified, we inject these locally so the user is never left with
 * a dead-end fallback summary and no questions to answer. Matches the
 * shape the Chair is supposed to emit itself per its prompt rules.
 */
function fallbackRequirementsQuestions(req: PlanRequirements): ChairQuestion[] {
  const qs: ChairQuestion[] = [];
  if (req.wordCountMin === null && req.wordCountMax === null) {
    qs.push({
      id: 'q-word-count',
      type: 'choice',
      prompt: 'Rough word count for the piece?',
      rationale: 'The panel can\'t judge scope without this.',
      allowCustom: true,
      choices: [
        { id: 'short', label: '800–1,500 words (short essay / blog post)' },
        { id: 'medium', label: '1,500–2,500 words (standard essay)', recommended: true },
        { id: 'long', label: '2,500–4,000 words (long essay / report)' },
      ],
    });
  }
  if (!req.form) {
    qs.push({
      id: 'q-form',
      type: 'choice',
      prompt: 'What form should this take?',
      allowCustom: true,
      choices: [
        { id: 'essay', label: 'Exploratory essay', recommended: true },
        { id: 'blog', label: 'Blog post' },
        { id: 'op-ed', label: 'Op-ed / opinion piece' },
        { id: 'report', label: 'Report / analysis' },
      ],
    });
  }
  if (!req.audience) {
    qs.push({
      id: 'q-audience',
      type: 'choice',
      prompt: 'Who are you writing this for?',
      allowCustom: true,
      choices: [
        { id: 'general', label: 'General educated reader', recommended: true },
        { id: 'domain', label: 'Subject-matter specialists' },
        { id: 'mixed', label: 'Mixed — some background, but accessible' },
      ],
    });
  }
  return qs;
}

/**
 * Map answers to our fallback question ids onto a concrete requirements
 * patch. This is the deterministic escape-hatch for when the Chair LLM
 * call keeps failing: the user can still answer the hard-coded fallback
 * questions, we translate the choice ids here, and the orchestrator
 * applies the patch locally — no Chair needed.
 *
 * Returns null when the answer map doesn't include any of our fallback
 * question ids (e.g. the user answered Chair-authored questions; the
 * Chair will handle `requirementsPatch` itself in that case).
 */
export function applyFallbackRequirementsPatch(
  answers: ChairAnswerMap,
): Partial<PlanRequirements> | null {
  const patch: Partial<PlanRequirements> = {};
  const wc = answers['q-word-count'];
  if (typeof wc === 'string') {
    if (wc === 'short') {
      patch.wordCountMin = 800;
      patch.wordCountMax = 1500;
    } else if (wc === 'medium') {
      patch.wordCountMin = 1500;
      patch.wordCountMax = 2500;
    } else if (wc === 'long') {
      patch.wordCountMin = 2500;
      patch.wordCountMax = 4000;
    } else if (wc.trim().length > 0) {
      // Custom write-in. Try to extract a number or a range like "1800" /
      // "2000-3000" / "around 1500".
      const range = wc.match(/(\d{3,5})\s*[-–to]+\s*(\d{3,5})/i);
      if (range) {
        const a = parseInt(range[1]!, 10);
        const b = parseInt(range[2]!, 10);
        patch.wordCountMin = Math.min(a, b);
        patch.wordCountMax = Math.max(a, b);
      } else {
        const single = wc.match(/(\d{3,5})/);
        if (single) {
          const n = parseInt(single[1]!, 10);
          patch.wordCountMin = n;
          patch.wordCountMax = n;
        }
      }
    }
  }
  const form = answers['q-form'];
  if (typeof form === 'string') {
    const map: Record<string, string> = {
      essay: 'exploratory essay',
      blog: 'blog post',
      'op-ed': 'op-ed',
      report: 'report',
    };
    patch.form = map[form] ?? form.trim();
  }
  const audience = answers['q-audience'];
  if (typeof audience === 'string') {
    const map: Record<string, string> = {
      general: 'general educated reader',
      domain: 'subject-matter specialists',
      mixed: 'mixed — some background, but accessible',
    };
    patch.audience = map[audience] ?? audience.trim();
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

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
  /** Anchors not yet shown to the Chair (filtered against `session.seenAnchorIds`). */
  newAnchors: AnchorLogEntry[];
  /** Total anchor count across the wiki, for the "you've seen N already" prompt line. */
  totalAnchorCount: number;
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
    newAnchors: args.newAnchors,
    totalAnchorCount: args.totalAnchorCount,
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

  // Fallback factory: NEVER advances phase on error (the old default of
  // phaseAdvance=true raced past unset requirements). When hard
  // requirements are still missing we inject local fallback questions so
  // the user always has something to act on — even if the Chair's LLM
  // call failed entirely.
  const fallback = (summary: string): ChairOutput => ({
    summary,
    visionUpdate: null,
    questions: fallbackRequirementsQuestions(args.session.requirements),
    phaseAdvance: false,
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
      `I hit an error synthesising the panel: ${(err as Error).message}. Try answering any questions below, or hit "Take to panel" to retry.`,
    );
  }

  broadcast(IpcChannels.DeepPlan.PanelProgress, { kind: 'chair-done' });

  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'chair.emptyReply', { chairModel: model });
    const missingReqs = fallbackRequirementsQuestions(args.session.requirements);
    const summary =
      missingReqs.length > 0
        ? `Let\'s pin down the basics first — a few quick questions below so the panel can focus properly.`
        : `My synthesis step came back empty (model issue). Keep chatting with me or hit "Take to panel" to retry.`;
    return fallback(summary);
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
        `${salvaged}\n\n(My response got cut off before I could finish the full update. Hit "Take to panel" to retry this round, or keep chatting.)`,
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
  });

  return parsed;
}
