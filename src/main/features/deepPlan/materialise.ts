import type { SourceMeta } from '@shared/types';
import { log } from '../../platform';
import { readAnchor } from '../sources/lookup';

/**
 * Post-process the Chair's plan.md so every `([Name](slug.md#anchor-id))`
 * citation has the anchor's verbatim passage immediately beneath it as a
 * markdown blockquote. The Chair only ever emits the citation marker — it
 * doesn't have the anchor text in context. This pass reads `<slug>.index.json`
 * for each distinct anchor referenced and inserts the quote deterministically.
 *
 * After this pass, plan.md is fully self-contained: the drafter can read it
 * in isolation (no source lookups, no rich sources block) and still have
 * every grounding quote at hand.
 *
 * Also emits an `unanchored` count — plain-English sentences in the body
 * that appear factual but carry no citation. This is logged (not blocking)
 * so we can eyeball whether the panel loop is converging on "every claim
 * anchored" or still leaving prose floating.
 */

// Match `([Name](slug.md#anchor-id))`. Name can contain anything that isn't
// a `]`; slug is the usual identifier charset; anchor-id is slug-safe.
const CITATION_RE = /\(\[([^\]]+)\]\(([A-Za-z0-9_\-./]+?)\.md#([A-Za-z0-9_\-.]+)\)\)/g;

// Match a plain slug-only citation `([Name](slug.md))` — used only for
// counting, never materialised (no anchor to look up).
const SLUG_ONLY_CITATION_RE = /\(\[([^\]]+)\]\(([A-Za-z0-9_\-./]+?)\.md\)\)/g;

interface AnchorKey {
  slug: string;
  anchorId: string;
}

function keyOf(slug: string, anchorId: string): string {
  return `${slug}#${anchorId}`;
}

/**
 * Scan plan.md for all unique `slug#anchor-id` references, resolve each via
 * `readAnchor`, and return a map of `slug#id` → verbatim text. Missing
 * anchors map to `null` so callers can fail loud (skip the blockquote for
 * that citation) rather than paste empty quotes.
 */
async function resolveAllAnchors(
  plan: string,
  sources: SourceMeta[],
): Promise<Map<string, string | null>> {
  const knownSlugs = new Set(sources.map((s) => s.slug));
  const keys = new Map<string, AnchorKey>();
  for (const match of plan.matchAll(CITATION_RE)) {
    const slug = match[2]!.split('/').filter(Boolean).pop() ?? match[2]!;
    const anchorId = match[3]!;
    if (!knownSlugs.has(slug)) continue;
    keys.set(keyOf(slug, anchorId), { slug, anchorId });
  }
  const out = new Map<string, string | null>();
  await Promise.all(
    Array.from(keys.values()).map(async ({ slug, anchorId }) => {
      try {
        const hit = await readAnchor(slug, anchorId);
        out.set(keyOf(slug, anchorId), hit ? hit.text : null);
      } catch {
        out.set(keyOf(slug, anchorId), null);
      }
    }),
  );
  return out;
}

/**
 * Materialise blockquotes. For each citation, append a blockquote containing
 * the anchor's verbatim text immediately after the sentence it sits in. If
 * the sentence already has a blockquote following it (i.e. the Chair wrote
 * one — shouldn't happen, but defensive), we skip to avoid duplication.
 *
 * We operate line-by-line on plan.md. For any line containing one or more
 * `([Name](slug.md#anchor-id))` citations, we emit the line followed by a
 * blockquote per unique anchor referenced ON THAT LINE. If the next non-blank
 * line is already a `>` blockquote, we skip insertion for that citation —
 * the Chair may have pre-quoted it.
 */
function injectBlockquotes(plan: string, resolved: Map<string, string | null>): string {
  const lines = plan.split('\n');
  const out: string[] = [];
  const alreadyInjected = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);

    // Collect unique anchor keys referenced on this line, preserving order.
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const match of line.matchAll(CITATION_RE)) {
      const slug = match[2]!.split('/').filter(Boolean).pop() ?? match[2]!;
      const anchorId = match[3]!;
      const k = keyOf(slug, anchorId);
      if (!seen.has(k)) {
        seen.add(k);
        refs.push(k);
      }
    }
    if (refs.length === 0) continue;

    // Peek forward past blank lines — if the Chair already emitted a
    // blockquote, don't add another one for the FIRST anchor on the line
    // (good enough; a second citation on the same line without its own
    // blockquote still gets one).
    let peek = i + 1;
    while (peek < lines.length && lines[peek]!.trim() === '') peek++;
    const nextIsBlockquote = peek < lines.length && lines[peek]!.trim().startsWith('>');

    for (let r = 0; r < refs.length; r++) {
      const k = refs[r]!;
      if (alreadyInjected.has(k)) continue;
      if (r === 0 && nextIsBlockquote) continue;
      const text = resolved.get(k);
      if (!text || !text.trim()) continue;
      out.push('');
      // Collapse internal newlines into blockquote continuations so the
      // rendered passage stays one visual block.
      const quoted = text
        .trim()
        .split('\n')
        .map((ln) => `> ${ln}`)
        .join('\n');
      out.push(quoted);
      alreadyInjected.add(k);
    }
  }
  return out.join('\n');
}

/**
 * Debug lint. Split plan.md into sentence-ish chunks (blockquotes and
 * headings excluded), and count ones that don't have at least one citation.
 * This isn't a hard gate — the panel loop is the thing that converges plan
 * toward full anchoring — but the count + a sample is invaluable for
 * eyeballing whether the new pipeline is working.
 */
function unanchoredLint(plan: string): { unanchored: number; sample: string[] } {
  const sample: string[] = [];
  let unanchored = 0;
  for (const rawLine of plan.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // Headings.
    if (line.startsWith('>')) continue; // Materialised blockquotes.
    if (line.startsWith('-') || line.startsWith('*') || /^\d+\./.test(line)) {
      // List items can be trivial section names — skip unless they look
      // substantive (> 40 chars) AND contain no citation.
      if (line.length < 40) continue;
    }
    // Split the line into sentences via period/question/exclamation.
    const sentences = line
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of sentences) {
      // Trivially-short fragments skip the lint (fewer than ~6 words).
      const wordCount = s.split(/\s+/).length;
      if (wordCount < 6) continue;
      CITATION_RE.lastIndex = 0;
      SLUG_ONLY_CITATION_RE.lastIndex = 0;
      const hasAnchor = CITATION_RE.test(s) || SLUG_ONLY_CITATION_RE.test(s);
      if (hasAnchor) continue;
      unanchored++;
      if (sample.length < 3) sample.push(s.slice(0, 140));
    }
  }
  return { unanchored, sample };
}

/**
 * Top-level entry. Resolve every anchor referenced in plan, inject verbatim
 * blockquotes, and log the unanchored-sentence count for visibility. Returns
 * the rewritten plan string.
 */
export async function materialiseAnchors(
  plan: string,
  sources: SourceMeta[],
): Promise<{ plan: string; unanchored: number; materialised: number }> {
  if (!plan.trim()) return { plan, unanchored: 0, materialised: 0 };
  const resolved = await resolveAllAnchors(plan, sources);
  const materialised = Array.from(resolved.values()).filter(
    (v) => v !== null && v.trim().length > 0,
  ).length;
  const rewritten = injectBlockquotes(plan, resolved);
  const { unanchored, sample } = unanchoredLint(rewritten);
  log('deep-plan', 'chair.anchorLint', {
    materialised,
    unresolved: resolved.size - materialised,
    unanchoredSentences: unanchored,
    sample,
  });
  return { plan: rewritten, unanchored, materialised };
}
