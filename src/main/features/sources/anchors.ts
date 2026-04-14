import type { SourceAnchor, SourceAnchorType } from '@shared/types';
import { log } from '../../platform';

/**
 * Anchor post-processing. The LLM returns anchors with `excerpt` (a verbatim
 * substring of the raw source) and `label`. We:
 *   1. Locate each excerpt in the raw text via indexOf → charStart/charEnd.
 *   2. Drop anchors whose excerpt does not match verbatim (LLM paraphrased).
 *   3. Drop anchors whose excerpt appears more than once (ambiguous locator).
 *   4. Slugify labels into stable ids, suffixing on collision.
 *
 * The "determinism" of deep reference lives here: from this point on,
 * retrieval is a byte-range read.
 */

const ANCHOR_TYPES: readonly SourceAnchorType[] = [
  'definition',
  'rule',
  'argument',
  'idea',
  'equation',
  'finding',
  'section',
];

export interface RawLlmAnchor {
  type?: unknown;
  label?: unknown;
  keywords?: unknown;
  excerpt?: unknown;
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'anchor'
  );
}

function coerceType(value: unknown): SourceAnchorType | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase() as SourceAnchorType;
  return ANCHOR_TYPES.includes(lower) ? lower : null;
}

function coerceKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, 8);
}

export function locateAnchors(raw: string, llmAnchors: RawLlmAnchor[]): SourceAnchor[] {
  const out: SourceAnchor[] = [];
  const usedIds = new Set<string>();
  let dropped = 0;

  for (const item of llmAnchors) {
    const type = coerceType(item.type);
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const excerpt = typeof item.excerpt === 'string' ? item.excerpt : '';
    if (!type || !label || excerpt.length < 3) {
      dropped++;
      continue;
    }

    const charStart = raw.indexOf(excerpt);
    if (charStart < 0) {
      dropped++;
      continue;
    }
    // Ambiguous: same excerpt appears again later in raw → locator is not unique.
    if (raw.indexOf(excerpt, charStart + 1) !== -1) {
      dropped++;
      continue;
    }

    let id = slugify(label);
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    out.push({
      id,
      type,
      label,
      keywords: coerceKeywords(item.keywords),
      charStart,
      charEnd: charStart + excerpt.length,
    });
  }

  if (dropped > 0) {
    log('sources', 'anchors.dropped', { dropped, kept: out.length });
  }
  return out;
}
