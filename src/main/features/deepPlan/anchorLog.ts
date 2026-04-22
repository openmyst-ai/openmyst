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
export async function resolveAndAppendAnchors(args: {
  proposals: { id: string; note?: string }[];
  existingLog: AnchorLogEntry[];
  currentPhase: DeepPlanPhase;
}): Promise<AnchorLogEntry[]> {
  const seen = new Set(args.existingLog.map((e) => e.id));
  const out: AnchorLogEntry[] = [];
  let dropped = 0;
  const now = new Date().toISOString();

  for (const p of args.proposals) {
    const id = p.id.trim();
    if (!id || seen.has(id)) continue;
    const hashIdx = id.indexOf('#');
    if (hashIdx < 0) {
      dropped++;
      continue;
    }
    const slug = id.slice(0, hashIdx);
    const anchorId = id.slice(hashIdx + 1);
    if (!slug || !anchorId) {
      dropped++;
      continue;
    }
    const hit = await readAnchor(slug, anchorId);
    if (!hit) {
      dropped++;
      continue;
    }
    seen.add(id);
    const entry: AnchorLogEntry = {
      id,
      slug,
      sourceName: hit.sourceName ?? slug,
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

  if (dropped > 0 || out.length > 0) {
    log('deep-plan', 'anchorLog.append', { appended: out.length, dropped });
  }
  return out;
}
