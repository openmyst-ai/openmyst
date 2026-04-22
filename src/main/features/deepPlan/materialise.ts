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
 * Phase-1.2 guarantee: NO broken citation ever ships to the user. We
 * scan every `([Name](slug.md#anchor-id))` citation and, for any whose
 * anchor-id isn't in the source's index (Chair hallucinated it), we
 * rewrite the citation to slug-only + a trailing `[needs-anchor]` marker.
 *
 * Effect downstream:
 *   - hover UI: stops saying "Anchor not found" because the broken
 *     `#anchor-id` is gone from rendered markdown.
 *   - panel loop: `[needs-anchor]` is the panel's to-do list, so the
 *     downgrade automatically becomes a research target next round.
 *
 * This is the deterministic safety net behind the prompt-side rules —
 * the Chair may still try to hallucinate; we just never let it land.
 */
function downgradeHallucinatedAnchors(
  plan: string,
  resolved: Map<string, string | null>,
): { plan: string; downgraded: number } {
  let downgraded = 0;
  const rewritten = plan.replace(CITATION_RE, (match, name: string, slugPath: string, anchorId: string) => {
    const slug = slugPath.split('/').filter(Boolean).pop() ?? slugPath;
    const key = keyOf(slug, anchorId);
    const resolution = resolved.get(key);
    // `resolved` only has entries for citations whose slug is in the wiki.
    // `undefined` = slug unknown, `null` = slug known but anchor missing,
    // string = resolved. We only downgrade the second case — unknown-slug
    // citations are a separate failure mode and get logged elsewhere.
    if (resolution === null) {
      downgraded++;
      return `([${name}](${slug}.md)) [needs-anchor]`;
    }
    return match;
  });
  return { plan: rewritten, downgraded };
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

const NEEDS_ANCHOR_RE = /\[needs-anchor\]/gi;

/**
 * Matches an inline claim-id annotation: `<!-- claim:c42 -->`. These are
 * injected by `annotateClaimIds` onto every cited/marked claim line so
 * the Chair can reference the line by a stable id across rounds. HTML
 * comments render as nothing, so they're invisible in the rendered plan.
 * Lever 2 of the token-efficiency work uses these IDs as patch keys.
 */
const CLAIM_ID_RE = /<!--\s*claim:(c\d+)\s*-->/;
const CLAIM_ID_RE_G = /<!--\s*claim:(c\d+)\s*-->/g;

/**
 * Walk plan.md line-by-line. Any line that (a) carries a citation or (b)
 * carries a `[needs-anchor]` marker, and doesn't already have a claim id,
 * gets one appended as `<!-- claim:cN -->`. Existing ids are preserved so
 * the Chair's "modify claim cN" patch-language stays meaningful across
 * rounds.
 *
 * Returns the annotated plan + the highest claim id now in use so callers
 * can plumb it back to session state if they want.
 */
function annotateClaimIds(plan: string): { plan: string; maxId: number } {
  // Scan existing ids so new ones don't collide.
  let maxSeen = 0;
  for (const m of plan.matchAll(CLAIM_ID_RE_G)) {
    const n = Number((m[1] ?? '').replace(/^c/, ''));
    if (Number.isFinite(n) && n > maxSeen) maxSeen = n;
  }
  const lines = plan.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (CLAIM_ID_RE.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue; // Headings.
    if (trimmed.startsWith('>')) continue; // Blockquotes.
    CITATION_RE.lastIndex = 0;
    SLUG_ONLY_CITATION_RE.lastIndex = 0;
    NEEDS_ANCHOR_RE.lastIndex = 0;
    const hasCitation =
      CITATION_RE.test(trimmed) ||
      SLUG_ONLY_CITATION_RE.test(trimmed) ||
      NEEDS_ANCHOR_RE.test(trimmed);
    if (!hasCitation) continue;
    maxSeen += 1;
    lines[i] = `${line.replace(/\s+$/, '')} <!-- claim:c${maxSeen} -->`;
  }
  return { plan: lines.join('\n'), maxId: maxSeen };
}

/**
 * Enumerate every claim id currently in plan.md, preserving reading order.
 * The Chair references these ids when emitting a `planPatch`, and the
 * applier uses them to locate the matching line for edit/drop operations.
 */
export function listClaimIds(plan: string): string[] {
  const ids: string[] = [];
  for (const m of plan.matchAll(CLAIM_ID_RE_G)) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * Chair's opt-in patch format. When the round's changes are narrow (edit
 * a sentence, drop one claim, add one new claim) this is drastically
 * cheaper to emit than a full plan rewrite. Each entry is keyed by a
 * `cN` claim id from the previous round's annotated plan.md.
 *
 * Applied by `applyPlanPatch`. If any operation's claim id doesn't exist,
 * that op is skipped (logged loud) and the rest of the patch still runs.
 * The Chair is told to fall back to a full plan rewrite if the changes
 * are large enough that a patch would be noisy.
 */
export interface PlanPatch {
  edits?: { claimId: string; newLine: string }[];
  drops?: string[];
  adds?: { afterClaimId: string | null; line: string }[];
}

/**
 * Apply a patch to the existing plan. `afterClaimId: null` on an add means
 * "insert at the end of the plan body (before any References/closing
 * section)". Claim ids in new lines are NOT auto-assigned here; the next
 * materialiser pass will tag them on its normal walk.
 */
export function applyPlanPatch(plan: string, patch: PlanPatch): {
  plan: string;
  applied: number;
  skipped: number;
} {
  let applied = 0;
  let skipped = 0;
  const lines = plan.split('\n');

  // Build a claim-id → line-index map for fast edit/drop lookups.
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(CLAIM_ID_RE);
    if (m && m[1]) idToIdx.set(m[1], i);
  }

  // Apply drops first (so edit/add indices stay stable relative to dropped
  // lines, which we replace with a sentinel and strip at the end).
  const DROPPED = ' DROPPED ';
  for (const id of patch.drops ?? []) {
    const idx = idToIdx.get(id);
    if (idx === undefined) {
      skipped++;
      continue;
    }
    lines[idx] = DROPPED;
    applied++;
  }

  // Edits: replace the line outright, but append the claim-id comment if
  // the model dropped it so the next round can still reference this line.
  for (const edit of patch.edits ?? []) {
    const idx = idToIdx.get(edit.claimId);
    if (idx === undefined || lines[idx] === DROPPED) {
      skipped++;
      continue;
    }
    const hasId = CLAIM_ID_RE.test(edit.newLine);
    lines[idx] = hasId
      ? edit.newLine
      : `${edit.newLine.replace(/\s+$/, '')} <!-- claim:${edit.claimId} -->`;
    applied++;
  }

  // Adds: insert after the named claim, or at plan end when null. Collect
  // inserts first, then apply in reverse so earlier indices don't shift.
  const inserts: { atIdx: number; line: string }[] = [];
  for (const add of patch.adds ?? []) {
    if (add.afterClaimId === null) {
      inserts.push({ atIdx: lines.length, line: add.line });
      applied++;
      continue;
    }
    const idx = idToIdx.get(add.afterClaimId);
    if (idx === undefined || lines[idx] === DROPPED) {
      skipped++;
      continue;
    }
    inserts.push({ atIdx: idx + 1, line: add.line });
    applied++;
  }
  inserts.sort((a, b) => b.atIdx - a.atIdx);
  for (const ins of inserts) {
    lines.splice(ins.atIdx, 0, ins.line);
  }

  const stripped = lines.filter((l) => l !== DROPPED);
  return { plan: stripped.join('\n'), applied, skipped };
}

/**
 * Count every Harvard-style citation in plan text — both \`#anchor-id\`
 * anchored and slug-only. Used for continuity monitoring: if the Chair's
 * rewritten plan has fewer citations than the prior plan, it dropped
 * committed evidence and we log loud.
 */
export function countCitations(plan: string): number {
  CITATION_RE.lastIndex = 0;
  SLUG_ONLY_CITATION_RE.lastIndex = 0;
  const anchored = plan.match(CITATION_RE)?.length ?? 0;
  // SLUG_ONLY also matches `([Name](slug.md))` substrings inside the fuller
  // anchored form, because `slug.md` is a prefix of `slug.md#id`. Subtract
  // the anchored count to avoid double-counting.
  const slugOnlyRaw = plan.match(SLUG_ONLY_CITATION_RE)?.length ?? 0;
  return anchored + Math.max(0, slugOnlyRaw - anchored);
}

/**
 * Debug lint. Walk plan.md sentence-ish and bucket each non-trivial
 * sentence into: anchored (has a valid Harvard-link citation), explicitly
 * marked as needing an anchor (Chair emitted the \`[needs-anchor]\` token),
 * or silently unanchored (neither). The third bucket is the interesting
 * one — it means the Chair dropped evidence without admitting it.
 */
function unanchoredLint(plan: string): {
  silentlyUnanchored: number;
  needsAnchor: number;
  sample: string[];
} {
  const sample: string[] = [];
  let silentlyUnanchored = 0;
  let needsAnchor = 0;
  for (const rawLine of plan.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('>')) continue;
    if (line.startsWith('-') || line.startsWith('*') || /^\d+\./.test(line)) {
      if (line.length < 40) continue;
    }
    const sentences = line
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of sentences) {
      const wordCount = s.split(/\s+/).length;
      if (wordCount < 6) continue;
      CITATION_RE.lastIndex = 0;
      SLUG_ONLY_CITATION_RE.lastIndex = 0;
      NEEDS_ANCHOR_RE.lastIndex = 0;
      if (CITATION_RE.test(s) || SLUG_ONLY_CITATION_RE.test(s)) continue;
      NEEDS_ANCHOR_RE.lastIndex = 0;
      if (NEEDS_ANCHOR_RE.test(s)) {
        needsAnchor++;
        continue;
      }
      silentlyUnanchored++;
      if (sample.length < 3) sample.push(s.slice(0, 140));
    }
  }
  return { silentlyUnanchored, needsAnchor, sample };
}

/**
 * Top-level entry. Resolve every anchor referenced in plan, inject verbatim
 * blockquotes, and log the unanchored-sentence count for visibility. Returns
 * the rewritten plan string.
 */
export async function materialiseAnchors(
  plan: string,
  sources: SourceMeta[],
): Promise<{
  plan: string;
  silentlyUnanchored: number;
  needsAnchor: number;
  materialised: number;
  hallucinatedAnchors: number;
}> {
  if (!plan.trim()) {
    return {
      plan,
      silentlyUnanchored: 0,
      needsAnchor: 0,
      materialised: 0,
      hallucinatedAnchors: 0,
    };
  }
  const resolved = await resolveAllAnchors(plan, sources);
  const materialised = Array.from(resolved.values()).filter(
    (v) => v !== null && v.trim().length > 0,
  ).length;
  // Phase 1.2: deterministically rewrite any hallucinated citation to
  // slug-only + `[needs-anchor]`. After this pass, no `#anchor-id` that
  // fails to resolve can survive into the rendered plan — hover can't
  // report "anchor not found" because the broken form isn't there anymore.
  const { plan: downgradedPlan, downgraded: hallucinatedAnchors } =
    downgradeHallucinatedAnchors(plan, resolved);
  const withQuotes = injectBlockquotes(downgradedPlan, resolved);
  // Lever 2: annotate each cited/marked claim line with a stable claim id
  // so the Chair can reference it in a `planPatch` next round instead of
  // rewriting the whole plan. Comments are invisible in rendered markdown.
  const { plan: rewritten } = annotateClaimIds(withQuotes);
  const { silentlyUnanchored, needsAnchor, sample } = unanchoredLint(rewritten);
  log('deep-plan', 'chair.anchorLint', {
    materialised,
    hallucinatedAnchors,
    needsAnchorMarkers: needsAnchor,
    silentlyUnanchored,
    sample,
  });
  return {
    plan: rewritten,
    silentlyUnanchored,
    needsAnchor,
    materialised,
    hallucinatedAnchors,
  };
}
