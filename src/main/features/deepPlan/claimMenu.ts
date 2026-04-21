import { randomUUID } from 'node:crypto';
import type { ClaimMenuItem, SourceMeta } from '@shared/types';
import { completeText, type LlmMessage } from '../../llm';
import { log, logError } from '../../platform';

/**
 * Pre-draft claim-menu extraction.
 *
 * Before the drafter runs, we ask the cheap summary model to read the wiki
 * and enumerate every atomic citable claim as a `{claim, slug, anchor,
 * quote}` row. The drafter is then told it may ONLY make non-trivial
 * factual assertions that map to a row in this menu — anything else must
 * be rephrased or cut. Hallucination becomes structurally difficult
 * because the model can't justify a claim that isn't on the menu.
 *
 * The menu is also used downstream by the confidence-rating pass: each
 * inline citation in the final draft is matched against its source's
 * claim quotes to compute a token-ngram overlap score, so the menu
 * doubles as the grounding index for that check.
 *
 * Failure modes degrade silently — if the extractor LLM call fails or
 * returns malformed JSON, we return an empty menu and the drafter falls
 * back to its old behaviour (warned by HARD RULES about citation
 * discipline). The worst outcome is we ship a draft without the extra
 * scoping constraint, which is what the pipeline did before.
 */

interface ExtractArgs {
  sources: SourceMeta[];
  detailedSummaries: Map<string, string>;
  summaryModel: string;
  docLabel: string;
}

/** Cap extraction per source so a very long summary can't blow up a single prompt. */
const MAX_CHARS_PER_SOURCE = 6000;
/** Cap final menu size so the drafter prompt stays manageable. */
const MAX_MENU_ITEMS = 400;

export async function extractClaimMenu(args: ExtractArgs): Promise<ClaimMenuItem[]> {
  if (args.sources.length === 0) return [];

  const sourcesBlock = args.sources
    .map((s) => {
      const detail = (args.detailedSummaries.get(s.slug) ?? s.indexSummary).trim();
      const clipped =
        detail.length > MAX_CHARS_PER_SOURCE
          ? detail.slice(0, MAX_CHARS_PER_SOURCE) + '\n…(truncated)'
          : detail;
      const anchorsLine =
        s.anchors && s.anchors.length > 0
          ? `\nAnchor labels for this source: ${s.anchors
              .map((a) => `${a.id}[${a.type}: ${a.label}]`)
              .join('; ')}`
          : '';
      return `### ${s.name} (slug: \`${s.slug}\`)${anchorsLine}\n\n${clipped}`;
    })
    .join('\n\n---\n\n');

  const systemPrompt = `You are building a CLAIM MENU for a research draft of "${args.docLabel}". Your job is to read the wiki below and enumerate every atomic, citable, non-trivial claim it contains. The draft that follows will be constrained to only assert facts that map to a row in this menu, so completeness matters — a missing claim means the drafter has to cut it from the essay.

What counts as a claim:
- A single factual assertion, historical fact, statistic, named position, definition, critique, finding, equation, or interpretive argument.
- Each row asserts ONE thing. No compound claims. "X because Y" is two claims, not one.
- Self-contained — the row must make sense without reading the source.
- Backed by a verbatim quote from the source (≤40 words). If no verbatim backing exists, skip the claim.

What NOT to extract:
- Common knowledge ("essays are a form of writing").
- Pure prose / narrative glue from the source.
- Meta-claims about the source itself ("this paper argues that...") — extract the underlying claim instead.
- Speculation or hedged statements ("might", "perhaps") unless the hedge is the point.

Wiki (read carefully before writing the menu):

${sourcesBlock}

Output ONLY a fenced \`json\` block with this exact shape — no prose, no explanation:

\`\`\`json
{
  "claims": [
    {
      "slug": "<exact slug from the wiki header>",
      "anchor": "<anchor id if the claim maps to a specific anchor label, otherwise one of: definition | rule | argument | idea | equation | finding | section>",
      "claim": "<≤25 words, one assertion, self-contained>",
      "quote": "<verbatim snippet from the source backing the claim, ≤40 words>"
    }
  ]
}
\`\`\`

Rules:
- \`slug\` must EXACTLY match a slug header above. Never invent slugs.
- \`quote\` must be a verbatim substring of the source text above (character-perfect). If you can't find backing text, DON'T include the claim.
- Target 5–30 claims per source depending on density. A two-paragraph summary might yield 5 claims; a long one might yield 30.
- Alphabetise or order however you like; the drafter will group them itself.
- Return \`{"claims": []}\` only if the wiki is genuinely empty or non-factual.`;

  const userPrompt = 'Emit the claim menu JSON now. No preamble, no prose around the fence.';
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
    logError('deep-plan', 'claimMenu.extract.failed', err);
    return [];
  }
  if (!reply || reply.trim().length === 0) {
    log('deep-plan', 'claimMenu.extract.empty', {});
    return [];
  }

  const parsed = parseJsonFromReply(reply);
  if (!parsed) {
    log('deep-plan', 'claimMenu.extract.malformed', { replyChars: reply.length });
    return [];
  }

  const raw = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(raw)) return [];

  const validSlugs = new Set(args.sources.map((s) => s.slug));
  const menu: ClaimMenuItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const slug = asTrimmedString((item as { slug: unknown }).slug);
    const anchor = asTrimmedString((item as { anchor: unknown }).anchor);
    const claim = asTrimmedString((item as { claim: unknown }).claim);
    const quote = asTrimmedString((item as { quote: unknown }).quote);
    if (!slug || !claim || !quote) continue;
    if (!validSlugs.has(slug)) continue;
    menu.push({
      id: `c${(menu.length + 1).toString(36)}-${randomUUID().slice(0, 4)}`,
      slug,
      anchor: anchor || 'section',
      claim,
      quote,
    });
    if (menu.length >= MAX_MENU_ITEMS) break;
  }

  log('deep-plan', 'claimMenu.extract.done', {
    sources: args.sources.length,
    items: menu.length,
    bySlug: menu.reduce<Record<string, number>>((acc, m) => {
      acc[m.slug] = (acc[m.slug] ?? 0) + 1;
      return acc;
    }, {}),
  });
  return menu;
}

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Pull the first JSON object out of a model reply. Accepts `json` fences,
 * bare triple-backtick fences, or a raw leading object. Returns null on
 * malformed input so the caller can degrade silently.
 */
function parseJsonFromReply(reply: string): unknown | null {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(reply);
  const candidate = (fenced ? (fenced[1] ?? '') : reply).trim();
  const firstBrace = candidate.indexOf('{');
  if (firstBrace === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) {
      escape = false;
      continue;
    }
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
          return JSON.parse(candidate.slice(firstBrace, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
