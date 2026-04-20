import type { SourceMeta } from '@shared/types';
import { completeText } from '../../llm';
import { logError } from '../../platform';
import { getSummaryModel } from '../settings';
import { locateAnchors, type RawLlmAnchor } from './anchors';
import type { SourceAnchor } from '@shared/types';

/**
 * Turn a blob of source text into a structured wiki entry using the LLM.
 *
 * Returns:
 *   - `name`         — short title the UI shows in the Sources panel
 *   - `summary`      — full wiki-style summary written to `sources/<slug>.md`
 *   - `indexSummary` — one-sentence version written to the wiki index
 *   - `anchors`      — located, id-stable deep-reference anchors with byte
 *                      offsets into the raw text. Empty array on fallback
 *                      or when the source has no citeable anchors.
 *
 * The LLM is told about existing sources in the project so it can drop
 * inline wikilinks like `[Other Source](other_slug.md)`. Those wikilinks are
 * what powers the research graph (see features/wiki/graph.ts).
 *
 * Anchors come back with a verbatim `excerpt` field; `locateAnchors` then
 * computes deterministic char offsets via indexOf and drops any that don't
 * match or are ambiguous. The LLM never emits offsets directly.
 *
 * If the API key is missing, or the LLM call fails, we degrade gracefully
 * (no anchors, truncated summary). Ingestion must always succeed.
 */

export interface SourceDigest {
  name: string;
  summary: string;
  indexSummary: string;
  anchors: SourceAnchor[];
  relatedSlugs: string[];
}

// Raw text cap the digest LLM sees. 24k chars ≈ 6k tokens, or ~5 pages of
// prose — enough to cover abstract + intro + most sections of a long paper,
// while staying well under any reasonable model's context budget. The old
// 6k cap was hitting the "shadow of the source" problem for any PDF longer
// than ~2 pages: the LLM summary would only reflect the abstract and TOC.
const MAX_PREVIEW_CHARS = 24000;

const SYSTEM_PROMPT = `You process source material into a research wiki entry. Given raw text from a source, output ONLY valid JSON with these fields:

{
  "name": "A short, descriptive title for this source (2-6 words)",
  "summary": "A detailed wiki-style summary of the source content. 2-4 paragraphs covering the key points, arguments, data, and conclusions. Write in third person. Be thorough — this summary replaces the original for research purposes. You may use markdown links to reference other sources if relevant, using the format [Source Name](slug.md).",
  "indexSummary": "One sentence (under 20 words) describing what this source covers, for quick scanning.",
  "anchors": [
    {
      "type": "definition | rule | argument | idea | equation | finding | section",
      "label": "Short human label for this anchor, e.g. 'Law 1.2: principle of least action' or 'definition of activation function' or 'main argument: free will is compatible with determinism'",
      "keywords": ["3-6 terms a future reader might match against"],
      "excerpt": "A VERBATIM substring of the raw source, copy-pasted exactly. Aim for a couple of sentences — longer or shorter is fine, but it must be long enough to be unique in the source and short enough to be citable. The excerpt MUST appear word-for-word in the raw text."
    }
  ],
  "relatedSlugs": ["other_slug", "another_slug"]
}

Direct links vs related slugs:
- Inline \`[Name](slug.md)\` wikilinks in the summary are for DIRECT references — places where this source builds on, cites, rebuts, or explicitly connects to another source. Use only when there's a real, specific connection worth clicking through for.
- \`relatedSlugs\` is for INDIRECT related-reading pointers — and the bar for inclusion is HIGH. The connection must be so close that a reader would say "obviously these two go together": same sub-topic + same angle, directly comparable method, one clearly extends/contradicts the other, or both are specific instances of the exact same concept. Generic "same broad field" is NOT enough. "Both about reinforcement learning" → no. "Both propose on-policy actor-critic variants" → yes.
- Default to FEW links. A general/foundational source covering a whole field should usually have 0–2 related links, not 10. A narrow source that sits in a specific conversation with other sources you've seen can have more. A summary/survey/review document that explicitly catalogs a body of work is the rare case where many links are appropriate — only then.
- When in doubt, leave it out. Fewer, tighter pointers make the graph useful; a long list of loosely-related entries makes it noise.
- Pick slugs (without \`.md\`) ONLY from the existing-sources list provided. Never invent slugs. Do not include this source's own slug.

Anchor rules (load-bearing):
- Every excerpt MUST be a verbatim substring of the raw source. Do not paraphrase, do not fix typos, do not add ellipses.
- Pick excerpts that are unique in the source — if the same sentence appears twice, choose a longer span that disambiguates.
- Extract anchors for: defined terms, laws/theorems/axioms, key arguments, notable ideas or claims, important equations, empirical findings with numbers, and major section landmarks.
- It's fine to return few anchors, or zero, if the source has nothing citeable. Don't invent anchors.
- Cap at ~40 anchors even for long sources.

Output ONLY the JSON object. No markdown fences, no commentary.`;

function fallbackDigest(rawText: string, hint: string): SourceDigest {
  return {
    name: hint,
    summary: rawText.slice(0, 500),
    indexSummary: `Source: ${hint}`,
    anchors: [],
    relatedSlugs: [],
  };
}

/**
 * Keep only slugs that refer to real, other sources in this project. Dedupe
 * and drop any self-reference. The LLM is asked to pick from the provided
 * list, but it occasionally hallucinates — this is the load-bearing check.
 */
export function sanitizeRelatedSlugs(
  raw: unknown,
  existingSources: SourceMeta[],
  selfHint: string,
): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Map(existingSources.map((s) => [s.slug, s]));
  const selfSlug = existingSources.find((s) => s.name === selfHint)?.slug ?? null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const slug = item.replace(/\.md$/i, '').trim();
    if (!slug || slug === selfSlug) continue;
    if (!known.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * Append a `## Related` section of wikilinks to the summary so the graph
 * builder's regex picks them up as edges — same mechanism as inline direct
 * references, just isolated at the end for readability. Returns the summary
 * unchanged when there's nothing to append.
 */
export function appendRelatedSection(
  summary: string,
  relatedSlugs: string[],
  existingSources: SourceMeta[],
): string {
  if (relatedSlugs.length === 0) return summary;
  const nameBySlug = new Map(existingSources.map((s) => [s.slug, s.name]));
  const lines = relatedSlugs.map((slug) => `- [${nameBySlug.get(slug) ?? slug}](${slug}.md)`);
  const trimmed = summary.replace(/\s+$/, '');
  return `${trimmed}\n\n## Related\n${lines.join('\n')}`;
}

function buildUserPrompt(rawText: string, hint: string, existingSources: SourceMeta[]): string {
  const preview = rawText.slice(0, MAX_PREVIEW_CHARS);
  const existingBlock = existingSources.length
    ? `\n\nExisting sources in this project (you can link to these using [Name](slug.md)):\n${existingSources
        .map((s) => `- ${s.name} (${s.slug}.md)`)
        .join('\n')}`
    : '';
  // Summary models otherwise default to their training-cutoff worldview —
  // handing them today's date lets them reason about how recent a source
  // is relative to "now" when it matters (e.g. noting a 2024 paper as
  // recent rather than cutting-edge, flagging pre-2020 claims as dated).
  const today = new Date().toISOString().slice(0, 10);
  return `Today's date: ${today}\nSource hint: "${hint}"${existingBlock}\n\nRaw text:\n${preview}`;
}

export async function generateDigest(
  rawText: string,
  hint: string,
  existingSources: SourceMeta[] = [],
): Promise<SourceDigest> {
  const model = await getSummaryModel();
  const raw = await completeText({
    model,
    logScope: 'sources',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(rawText, hint, existingSources) },
    ],
  });

  if (raw === null) return fallbackDigest(rawText, hint);

  try {
    const cleaned = raw.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const parsed = JSON.parse(cleaned) as {
      name?: unknown;
      summary?: unknown;
      indexSummary?: unknown;
      anchors?: unknown;
      relatedSlugs?: unknown;
    };
    const llmAnchors: RawLlmAnchor[] = Array.isArray(parsed.anchors)
      ? (parsed.anchors as RawLlmAnchor[])
      : [];
    // Offsets are resolved against the same prefix the LLM saw — that's
    // exactly what we persist to raw.txt. Keeps indexOf honest.
    const anchorInput = rawText.slice(0, MAX_PREVIEW_CHARS);
    const anchors = locateAnchors(anchorInput, llmAnchors);
    const name = typeof parsed.name === 'string' ? parsed.name : hint;
    const rawSummary =
      typeof parsed.summary === 'string' ? parsed.summary : rawText.slice(0, 500);
    const relatedSlugs = sanitizeRelatedSlugs(parsed.relatedSlugs, existingSources, name);
    const summary = appendRelatedSection(rawSummary, relatedSlugs, existingSources);
    return {
      name,
      summary,
      indexSummary:
        typeof parsed.indexSummary === 'string' ? parsed.indexSummary : `Source: ${hint}`,
      anchors,
      relatedSlugs,
    };
  } catch (err) {
    // Fallback used to be silent — made user-visible "summaries" that were
    // just the first 500 chars of the raw text. Log the model id and a
    // sample of the raw reply so it's obvious in the session log which
    // summary model is failing to produce valid JSON.
    logError('sources', 'digest.parseFailed', err, {
      model,
      rawHead: raw.slice(0, 200),
    });
    return fallbackDigest(rawText, hint);
  }
}

export { MAX_PREVIEW_CHARS };
