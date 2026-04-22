import type { AnchorLogEntry, DeepPlanPhase } from '@shared/types';
import { log } from '../../platform';
import { readAnchor } from '../sources/lookup';

/**
 * Anchor-log append path. The Chair emits `anchorLogAdd: [{id, note?}]`
 * each round. For each id:
 *   1. Skip if already in the log (append-only but idempotent).
 *   2. Resolve the anchor via `readAnchor` — which reads the source's
 *      index + meta file to fill name/type/text/keywords/url.
 *   3. If resolution fails (id doesn't exist in any source index, or the
 *      slug is unknown), silently drop it. The panel may propose ids
 *      that don't exist yet; logged for visibility but not surfaced to
 *      the user since the overhaul specifically said "don't have Chair
 *      double-check" — we rely on validation at append time.
 *
 * Returns the new entries that were actually appended, so callers can
 * update session.anchorLog in one shot.
 */
/**
 * Normalise a panel-proposed id into the canonical `slug#anchor-id` form.
 * Panel sees the wiki anchors rendered as `([Name](slug.md#anchor-id))` in
 * the wiki block and very often copies that whole href as the id —
 * including the `.md`. `readAnchor` reads `sources/<slug>.index.json`, so
 * a slug like `smith.md` produces the path `sources/smith.md.index.json`
 * which does not exist, and every single proposal gets silently dropped.
 *
 * This normaliser strips common malformations:
 *   - leading `(`, trailing `)` (from full citation blobs)
 *   - a `.md` suffix on the slug portion
 *   - any leading path fragments (`./`, `../`)
 * Leaves the anchor id untouched since those rarely get mangled.
 */
function normaliseAnchorId(raw: string): { slug: string; anchorId: string } | null {
  let id = raw.trim();
  // Strip stray wrapping characters the model sometimes emits.
  id = id.replace(/^[(\[\s]+/, '').replace(/[)\]\s]+$/, '');
  const hashIdx = id.indexOf('#');
  if (hashIdx < 0) return null;
  let slug = id.slice(0, hashIdx).trim();
  const anchorId = id.slice(hashIdx + 1).trim();
  if (!slug || !anchorId) return null;
  // Common case: panel pasted `slug.md#id` from the wiki href — strip .md.
  if (slug.toLowerCase().endsWith('.md')) slug = slug.slice(0, -3);
  // Strip any path leading (`./foo`, `../foo`, `folder/slug`) — the
  // resolver only looks under `sources/<slug>.index.json`.
  const parts = slug.split('/').filter(Boolean);
  slug = parts.length > 0 ? parts[parts.length - 1]! : slug;
  if (!slug) return null;
  return { slug, anchorId };
}

export async function resolveAndAppendAnchors(args: {
  proposals: { id: string; note?: string }[];
  existingLog: AnchorLogEntry[];
  currentPhase: DeepPlanPhase;
}): Promise<AnchorLogEntry[]> {
  const seen = new Set(args.existingLog.map((e) => e.id));
  const out: AnchorLogEntry[] = [];
  let droppedMalformed = 0;
  let droppedUnresolved = 0;
  let droppedDuplicate = 0;
  const unresolvedSample: string[] = [];
  const now = new Date().toISOString();

  for (const p of args.proposals) {
    const parsed = normaliseAnchorId(p.id);
    if (!parsed) {
      droppedMalformed++;
      continue;
    }
    const canonicalId = `${parsed.slug}#${parsed.anchorId}`;
    if (seen.has(canonicalId)) {
      droppedDuplicate++;
      continue;
    }
    const hit = await readAnchor(parsed.slug, parsed.anchorId);
    if (!hit) {
      droppedUnresolved++;
      if (unresolvedSample.length < 5) unresolvedSample.push(canonicalId);
      continue;
    }
    seen.add(canonicalId);
    const entry: AnchorLogEntry = {
      id: canonicalId,
      slug: parsed.slug,
      sourceName: hit.sourceName ?? parsed.slug,
      type: hit.anchor.type,
      text: hit.text,
      keywords: hit.anchor.keywords ?? [],
      addedAt: now,
      addedInPhase: args.currentPhase,
    };
    if (hit.sourceUrl) entry.sourceUrl = hit.sourceUrl;
    if (p.note && p.note.trim()) entry.note = p.note.trim();
    out.push(entry);
  }

  // Log loud when drops happen so any future malformation regressions
  // show up in the chair.done / panel.round.done traces. Sample of the
  // unresolved ids makes root-causing trivial next time.
  if (
    out.length > 0 ||
    droppedMalformed > 0 ||
    droppedUnresolved > 0 ||
    droppedDuplicate > 0
  ) {
    log('deep-plan', 'anchorLog.append', {
      appended: out.length,
      droppedMalformed,
      droppedUnresolved,
      droppedDuplicate,
      unresolvedSample,
    });
  }
  return out;
}
