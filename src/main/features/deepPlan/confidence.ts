import type { CitationConfidence, ClaimMenuItem, SourceMeta } from '@shared/types';
import { log } from '../../platform';

/**
 * Post-draft confidence scoring.
 *
 * The drafter produces inline citations of the form `([Name](slug.md))`.
 * For each citation we look at the sentence it sits in, match it against
 * the cited source's backing text (claim-menu quotes if available, else
 * the source summary), and compute a weighted token-ngram overlap. No LLM
 * in the loop — pure string math, so this never introduces new
 * hallucinations and runs instantly.
 *
 * The returned annotated draft has a badge `[N%](confidence://N)`
 * inserted right after each citation. The badge is a markdown link with
 * a custom scheme so the tiptap link handler ignores it (the renderer's
 * link router only follows .md links) while CSS can style the anchor
 * as a small muted pill.
 */

interface AnnotateArgs {
  draft: string;
  menu: ClaimMenuItem[];
  sources: SourceMeta[];
  detailedSummaries: Map<string, string>;
}

export interface AnnotateResult {
  annotatedDraft: string;
  ratings: CitationConfidence[];
}

/**
 * Harvard-style citation regex used by the drafter: `([Name](slug.md))`.
 * The parenthesised wrapping is the part the drafter is required to
 * emit; we only annotate citations that match exactly so a stray
 * `[Name](slug.md)` without outer parens doesn't pick up a badge.
 *
 * The slug is captured without the `.md` suffix for lookup. We also
 * refuse to badge citations whose URL already starts with `confidence://`
 * or ends with `.md)` twice (defensive — shouldn't happen).
 */
const CITATION_REGEX = /\(\[([^\]]+)\]\(([^)]+?)\.md\)\)/g;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'our', 'she', 'that', 'the', 'their', 'them', 'they', 'this',
  'to', 'was', 'we', 'were', 'which', 'with', 'you', 'your',
]);

export function annotateDraftWithConfidence(args: AnnotateArgs): AnnotateResult {
  const ratings: CitationConfidence[] = [];

  // Index the menu by slug for quick lookup. Each slug maps to an array
  // of backing quotes; we pick the best-matching one per citation.
  const quotesBySlug = new Map<string, string[]>();
  for (const item of args.menu) {
    const existing = quotesBySlug.get(item.slug) ?? [];
    existing.push(item.quote);
    quotesBySlug.set(item.slug, existing);
  }

  // Fallback backing text when a slug has no claim-menu entries — fall
  // back to the source's detailed summary (or indexSummary).
  const fallbackBySlug = new Map<string, string>();
  for (const s of args.sources) {
    const detail = args.detailedSummaries.get(s.slug) ?? s.indexSummary;
    fallbackBySlug.set(s.slug, detail);
  }

  // Walk citations in reading order and splice badges after each match.
  // Building the output piece-by-piece keeps the ratings linkIndex aligned
  // with the order a reader encounters citations on the page.
  let out = '';
  let cursor = 0;
  let linkIndex = 0;
  CITATION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_REGEX.exec(args.draft)) !== null) {
    const full = match[0];
    const slug = match[2] ?? '';
    const start = match.index;
    const end = start + full.length;

    const sentence = sentenceAround(args.draft, start, end);
    const backing =
      bestBackingQuote(sentence, quotesBySlug.get(slug) ?? []) ??
      fallbackBySlug.get(slug) ??
      '';
    const confidence = scoreOverlap(sentence, backing);
    // Encode a semantic tier in the URL so CSS can color-ramp without a
    // decoration plugin. The number is preserved in the path segment for
    // debug / future tooltip rendering.
    const tier = confidence >= 75 ? 'high' : confidence >= 45 ? 'mid' : 'low';
    const badge = `[${confidence}%](confidence://${tier}/${confidence})`;
    const backingSnippet = trimForSnippet(backing);

    ratings.push({ linkIndex, slug, confidence, backingSnippet });
    linkIndex++;

    out += args.draft.slice(cursor, end);
    out += ` ${badge}`;
    cursor = end;
  }
  out += args.draft.slice(cursor);

  log('deep-plan', 'confidence.annotate.done', {
    citations: ratings.length,
    mean:
      ratings.length === 0
        ? 0
        : Math.round(ratings.reduce((s, r) => s + r.confidence, 0) / ratings.length),
    below60: ratings.filter((r) => r.confidence < 60).length,
  });

  return { annotatedDraft: out, ratings };
}

/**
 * Pull the sentence (or tight clause) around the citation. We split on
 * `.`/`!`/`?` looking backward from the citation and forward from it,
 * ignoring the citation itself when computing overlap — otherwise the
 * citation name trivially appears on both sides.
 */
function sentenceAround(draft: string, start: number, end: number): string {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  // Look back for sentence start — a period, question mark, exclamation,
  // or newline. Capped at 400 chars so we don't grab a whole paragraph.
  const boundary = /[.!?\n]\s+(?=[A-Z])/g;
  let lastBoundary = 0;
  let m: RegExpExecArray | null;
  const beforeWindow = before.slice(Math.max(0, before.length - 400));
  const windowOffset = before.length - beforeWindow.length;
  while ((m = boundary.exec(beforeWindow)) !== null) {
    lastBoundary = windowOffset + m.index + m[0].length;
  }
  const sentenceStart = lastBoundary;
  const endMatch = /[.!?\n]/.exec(after);
  const sentenceEnd = end + (endMatch ? endMatch.index + 1 : Math.min(400, after.length));
  return draft.slice(sentenceStart, sentenceEnd);
}

/**
 * Pick the claim-menu quote that scores highest against the cited
 * sentence. If the slug has no quotes, caller falls back to the summary.
 */
function bestBackingQuote(sentence: string, quotes: string[]): string | null {
  if (quotes.length === 0) return null;
  let best: { quote: string; score: number } | null = null;
  for (const q of quotes) {
    const score = scoreOverlap(sentence, q);
    if (!best || score > best.score) best = { quote: q, score };
  }
  return best?.quote ?? quotes[0] ?? null;
}

/**
 * Weighted token-ngram overlap:
 *   0.4 × Jaccard(unigrams) + 0.6 × Jaccard(trigrams)
 * Unigrams drop stopwords; trigrams keep everything so phrase structure
 * matters. Percentage output is a rounded integer in [0, 100].
 *
 * Tuning rationale: unigram-only undervalues phrase-level agreement
 * ("chain of thought" ≠ "thought chains"), trigram-only is too brittle
 * when the drafter paraphrases. Weighting 60/40 toward trigrams rewards
 * lexical fidelity without being zero-tolerance.
 */
function scoreOverlap(sentence: string, backing: string): number {
  if (!sentence.trim() || !backing.trim()) return 0;
  const sTokens = tokenize(sentence);
  const bTokens = tokenize(backing);
  if (sTokens.length === 0 || bTokens.length === 0) return 0;

  const sUni = new Set(sTokens.filter((t) => !STOPWORDS.has(t)));
  const bUni = new Set(bTokens.filter((t) => !STOPWORDS.has(t)));
  const uniScore = jaccard(sUni, bUni);

  const sTri = ngramSet(sTokens, 3);
  const bTri = ngramSet(bTokens, 3);
  const triScore = jaccard(sTri, bTri);

  const weighted = 0.4 * uniScore + 0.6 * triScore;
  return Math.max(0, Math.min(100, Math.round(weighted * 100)));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function ngramSet(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length < n) {
    if (tokens.length > 0) out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i <= tokens.length - n; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trimForSnippet(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= 180) return clean;
  return clean.slice(0, 177) + '…';
}
