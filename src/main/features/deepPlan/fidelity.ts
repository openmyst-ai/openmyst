import type { DeepPlanRubric, SourceMeta } from '@shared/types';
import { completeText, type LlmMessage } from '../../llm';
import { log, logError } from '../../platform';
import { parseEditBlocks } from '../chat/editLogic';

/**
 * Draft fidelity verification loop.
 *
 * After the one-shot draft completes, we run a critique-then-rewrite cycle
 * to catch the two most common grounding failures:
 *   1. `unreferenced` — a non-trivial claim with no inline citation.
 *   2. `unsupported` — a citation that doesn't actually support the claim.
 *
 * The cheap summary model handles critique (reads draft + wiki summaries,
 * emits JSON). The main model handles rewrite (emits scoped `myst_edit`
 * fences keyed on the flagged passage). We apply edits in-memory and loop
 * until there are no issues or we hit `maxRounds`.
 *
 * Failure modes degrade silently: a malformed critique JSON reply, a
 * missing main-model reply, an edit whose old_string no longer matches —
 * any of these just end the loop without blocking the draft. The user
 * still gets the best draft we produced.
 */

export interface FidelityIssue {
  /** Verbatim sentence / clause from the draft — used as the edit target. */
  passage: string;
  kind: 'unreferenced' | 'unsupported';
  /** One-line nudge for the rewriter: "cite smith-2022" / "this claim actually contradicts smith-2022, cut or soften". */
  hint: string;
}

export interface FidelityUpdate {
  phase: 'critiquing' | 'rewriting' | 'done';
  round: number;
  maxRounds: number;
  issueCount: number;
  fixed: number;
}

export interface FidelityResult {
  finalDraft: string;
  roundsRun: number;
  totalIssuesFound: number;
  totalIssuesFixed: number;
}

interface RunArgs {
  draft: string;
  sources: SourceMeta[];
  detailedSummaries: Map<string, string>;
  prefetchedPassages: string;
  rubric: DeepPlanRubric;
  docLabel: string;
  mainModel: string;
  summaryModel: string;
  maxRounds?: number;
  onUpdate?: (u: FidelityUpdate) => void;
}

const DEFAULT_MAX_ROUNDS = 5;
/** Cap the per-round issue list so a hallucinating critique can't blow up the rewrite prompt. */
const MAX_ISSUES_PER_ROUND = 12;

export async function runFidelityLoop(args: RunArgs): Promise<FidelityResult> {
  const maxRounds = args.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let draft = args.draft;
  let totalFound = 0;
  let totalFixed = 0;
  let round = 0;

  for (; round < maxRounds; round++) {
    args.onUpdate?.({
      phase: 'critiquing',
      round: round + 1,
      maxRounds,
      issueCount: 0,
      fixed: totalFixed,
    });

    const issues = await critiqueDraft({
      draft,
      rubric: args.rubric,
      sources: args.sources,
      detailedSummaries: args.detailedSummaries,
      prefetchedPassages: args.prefetchedPassages,
      docLabel: args.docLabel,
      summaryModel: args.summaryModel,
    });

    log('deep-plan', 'fidelity.critique.done', {
      round: round + 1,
      issues: issues.length,
      kinds: issues.reduce(
        (acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }),
        {} as Record<string, number>,
      ),
    });

    if (issues.length === 0) {
      args.onUpdate?.({
        phase: 'done',
        round: round + 1,
        maxRounds,
        issueCount: 0,
        fixed: totalFixed,
      });
      break;
    }

    totalFound += issues.length;
    args.onUpdate?.({
      phase: 'rewriting',
      round: round + 1,
      maxRounds,
      issueCount: issues.length,
      fixed: totalFixed,
    });

    const { draft: nextDraft, fixed } = await rewriteIssues({
      draft,
      issues: issues.slice(0, MAX_ISSUES_PER_ROUND),
      rubric: args.rubric,
      sources: args.sources,
      detailedSummaries: args.detailedSummaries,
      docLabel: args.docLabel,
      mainModel: args.mainModel,
    });

    log('deep-plan', 'fidelity.rewrite.done', {
      round: round + 1,
      attempted: Math.min(issues.length, MAX_ISSUES_PER_ROUND),
      applied: fixed,
    });

    totalFixed += fixed;

    // If the rewriter produced zero applied edits, further rounds won't help —
    // the main model is either refusing or its edit targets aren't matching.
    // Break out rather than burning rounds.
    if (fixed === 0) {
      log('deep-plan', 'fidelity.rewrite.stuck', { round: round + 1 });
      round++;
      break;
    }

    draft = nextDraft;
  }

  args.onUpdate?.({
    phase: 'done',
    round,
    maxRounds,
    issueCount: 0,
    fixed: totalFixed,
  });

  return {
    finalDraft: draft,
    roundsRun: round,
    totalIssuesFound: totalFound,
    totalIssuesFixed: totalFixed,
  };
}

function richSourcesForCritique(
  sources: SourceMeta[],
  detailedSummaries: Map<string, string>,
): string {
  if (sources.length === 0) return '_(no sources)_';
  return sources
    .map((s) => {
      const detail = detailedSummaries.get(s.slug)?.trim() || s.indexSummary;
      return `### ${s.name} (\`${s.slug}\`)\n\n${detail}`;
    })
    .join('\n\n---\n\n');
}

async function critiqueDraft(args: {
  draft: string;
  rubric: DeepPlanRubric;
  sources: SourceMeta[];
  detailedSummaries: Map<string, string>;
  prefetchedPassages: string;
  docLabel: string;
  summaryModel: string;
}): Promise<FidelityIssue[]> {
  const sourcesBlock = richSourcesForCritique(args.sources, args.detailedSummaries);
  const passagesBlock = args.prefetchedPassages.trim()
    ? `\nPre-fetched verbatim passages (exact text from the wiki):\n\n${args.prefetchedPassages.trim()}\n`
    : '';

  const systemPrompt = `You are a strict fact-checking critic for a research draft of "${args.docLabel}". Your only job is to find claims that are not properly grounded in the wiki below, and return them as a JSON array.

Return TWO kinds of problems:
- "unreferenced": a specific factual claim, statistic, named position, historical fact, definition, or attribution that appears WITHOUT an inline citation at the point it's made. Inline citations in this draft take the form \`([Name](slug.md))\` — a parenthesised markdown link.
- "unsupported": a claim WITH a citation where the cited source does not actually support what the claim says. The source in the wiki contradicts, is silent on, or only tangentially touches the claim.

What NOT to flag:
- The author's own reasoning, framing, transitions, connective tissue, restatements of the user's prompt. Uncited is fine for these.
- Common knowledge (e.g. "essays are a form of writing"). Only flag a claim if a curious reader would reasonably want a citation.
- Hedged opinions ("I think", "arguably") — these are framing, not factual claims.
- The References section at the end.

Wiki (sources with detailed summaries):

${sourcesBlock}
${passagesBlock}
Rubric (what the draft aims at):
- Title: ${args.rubric.title ?? '(unset)'}
- Thesis: ${args.rubric.thesis ?? '(unset)'}
- Audience: ${args.rubric.audience ?? '(unset)'}

Output ONLY a fenced \`json\` block containing an object of this shape — no prose, no explanation:

\`\`\`json
{
  "issues": [
    {
      "passage": "<exact sentence or clause copied verbatim from the draft, short enough to uniquely locate>",
      "kind": "unreferenced" | "unsupported",
      "hint": "<one short line: what to cite, or why the current citation is wrong>"
    }
  ]
}
\`\`\`

Rules for the passage field:
- Must be an EXACT substring of the draft (character-perfect, including punctuation and dashes). It will be used as a find-target for a downstream editor — if it doesn't match, the fix is lost.
- Keep it to a single sentence or a tight clause (under ~200 chars). Don't paste whole paragraphs.
- Never combine multiple passages into one entry. One issue per entry.

If the draft is clean, return \`{"issues": []}\`.`;

  const userPrompt = `Draft to critique:\n\n---\n\n${args.draft}\n\n---\n\nReturn the JSON block now.`;

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let reply: string | null = null;
  try {
    reply = await completeText({
      model: args.summaryModel,
      messages,
      logScope: 'deep-plan',
    });
  } catch (err) {
    logError('deep-plan', 'fidelity.critique.failed', err);
    return [];
  }
  if (!reply || reply.trim().length === 0) return [];

  const parsed = parseJsonFromReply(reply);
  if (!parsed) {
    log('deep-plan', 'fidelity.critique.malformed', { replyChars: reply.length });
    return [];
  }

  const raw = parsed.issues;
  if (!Array.isArray(raw)) return [];
  const issues: FidelityIssue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const passage = typeof (item as { passage: unknown }).passage === 'string'
      ? ((item as { passage: string }).passage).trim()
      : '';
    const kind = (item as { kind: unknown }).kind;
    const hint = typeof (item as { hint: unknown }).hint === 'string'
      ? ((item as { hint: string }).hint).trim()
      : '';
    if (!passage) continue;
    if (kind !== 'unreferenced' && kind !== 'unsupported') continue;
    issues.push({ passage, kind, hint });
  }
  return issues;
}

async function rewriteIssues(args: {
  draft: string;
  issues: FidelityIssue[];
  rubric: DeepPlanRubric;
  sources: SourceMeta[];
  detailedSummaries: Map<string, string>;
  docLabel: string;
  mainModel: string;
}): Promise<{ draft: string; fixed: number }> {
  const sourcesBlock = richSourcesForCritique(args.sources, args.detailedSummaries);
  const issuesList = args.issues
    .map(
      (iss, i) =>
        `Issue ${i + 1} [${iss.kind}]:\n  passage: ${JSON.stringify(iss.passage)}\n  hint: ${iss.hint || '(none)'}`,
    )
    .join('\n\n');

  const systemPrompt = `You are repairing specific grounding problems in a near-final draft of "${args.docLabel}". The fact-checker has flagged a short list of passages. Your job: emit one \`myst_edit\` fence per issue, each a SCOPED rewrite of just that passage.

HARD RULES (these override anything else):
- ZERO em dashes (—). Use a period, comma, parentheses, or colon.
- EVERY non-trivial claim cites a source inline as \`([Name](slug.md))\`. If you cannot source it from the wiki below, cut or soften the claim — do not leave it uncited.
- Do NOT rewrite the whole draft. Only touch the flagged passages.
- Do NOT invent sources, slugs, or quotes. If a slug isn't in the wiki below, it doesn't exist.

Wiki (your only legitimate source of facts):

${sourcesBlock}

Rubric:
- Title: ${args.rubric.title ?? '(unset)'}
- Thesis: ${args.rubric.thesis ?? '(unset)'}
- Audience: ${args.rubric.audience ?? '(unset)'}

Flagged issues to fix:

${issuesList}

For each issue, emit a fenced code block of this form — no prose around it:

\`\`\`myst_edit
{
  "old_string": "<EXACT passage copied from the issue above — character-perfect>",
  "new_string": "<the repaired sentence or clause>"
}
\`\`\`

Rules for the fix:
- "unreferenced" → add an inline \`([Name](slug.md))\` citation to a wiki source that actually supports the claim, OR cut the claim if nothing in the wiki does.
- "unsupported" → either swap the citation for one that genuinely supports the claim, or soften/cut the claim until it matches what the wiki says.
- Keep the surrounding prose untouched where possible. A good repair is usually a few words changed, not a rewrite.
- If a passage simply cannot be salvaged (no source supports it at all), delete it by setting new_string to "" — the sentence goes away.

Output ONLY the myst_edit fences, one per issue, nothing else.`;

  const userPrompt = `Current draft (for context — do not echo it back):\n\n---\n\n${args.draft}\n\n---\n\nEmit the myst_edit fences now.`;

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let reply: string | null = null;
  try {
    reply = await completeText({
      model: args.mainModel,
      messages,
      logScope: 'deep-plan',
    });
  } catch (err) {
    logError('deep-plan', 'fidelity.rewrite.failed', err);
    return { draft: args.draft, fixed: 0 };
  }
  if (!reply) return { draft: args.draft, fixed: 0 };

  const { edits } = parseEditBlocks(reply);
  if (edits.length === 0) return { draft: args.draft, fixed: 0 };

  let out = args.draft;
  let fixed = 0;
  for (const edit of edits) {
    if (!edit.old_string) continue;
    const idx = out.indexOf(edit.old_string);
    if (idx === -1) continue;
    out = out.slice(0, idx) + edit.new_string + out.slice(idx + edit.old_string.length);
    fixed++;
  }
  return { draft: out, fixed };
}

/**
 * Pull the first JSON object out of a model reply. Accepts `json` fences,
 * bare ```` ``` ```` fences, or a raw leading object. We don't fail hard —
 * a malformed reply returns null and the loop terminates cleanly.
 */
function parseJsonFromReply(reply: string): { issues?: unknown } | null {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(reply);
  const candidate = (fenced ? fenced[1] : reply).trim();
  const firstBrace = candidate.indexOf('{');
  if (firstBrace === -1) return null;
  // Walk forward to find the matching closing brace, respecting string escaping.
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(firstBrace, i + 1)) as { issues?: unknown };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
