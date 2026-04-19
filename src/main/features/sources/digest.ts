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
  ]
}

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
  };
}

function buildUserPrompt(rawText: string, hint: string, existingSources: SourceMeta[]): string {
  const preview = rawText.slice(0, MAX_PREVIEW_CHARS);
  const existingBlock = existingSources.length
    ? `\n\nExisting sources in this project (you can link to these using [Name](slug.md)):\n${existingSources
        .map((s) => `- ${s.name} (${s.slug}.md)`)
        .join('\n')}`
    : '';
  return `Source hint: "${hint}"${existingBlock}\n\nRaw text:\n${preview}`;
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
    };
    const llmAnchors: RawLlmAnchor[] = Array.isArray(parsed.anchors)
      ? (parsed.anchors as RawLlmAnchor[])
      : [];
    // Offsets are resolved against the same prefix the LLM saw — that's
    // exactly what we persist to raw.txt. Keeps indexOf honest.
    const anchorInput = rawText.slice(0, MAX_PREVIEW_CHARS);
    const anchors = locateAnchors(anchorInput, llmAnchors);
    return {
      name: typeof parsed.name === 'string' ? parsed.name : hint,
      summary: typeof parsed.summary === 'string' ? parsed.summary : rawText.slice(0, 500),
      indexSummary:
        typeof parsed.indexSummary === 'string' ? parsed.indexSummary : `Source: ${hint}`,
      anchors,
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
