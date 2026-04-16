/**
 * Pure edit-format logic. No IO, no electron, no LLM calls — just string
 * manipulation. That means this file is the easiest one in the codebase to
 * test, and tests for every function here live in
 * `src/main/__tests__/editLogic.test.ts`.
 *
 * Responsibilities, in rough order of a chat turn:
 *   1. `parseEditBlocks`  — pull ```myst_edit ...``` blocks out of LLM output
 *   2. `validateEdits`    — check each edit locates exactly one span (unless
 *                           disambiguated by an explicit `occurrence`)
 *   3. `tryResolvePendingPatch` — if an edit doesn't hit the doc, maybe it
 *                                 targets text inside a PENDING edit (user is
 *                                 refining an un-accepted proposal)
 *   4. `mergePendingEdits` — dedupe "revise this pending edit" into the same
 *                            slot instead of piling up parallels
 *   5. `applyEditOccurrence(+Fuzzy)` — actually splice the new_string into the
 *                                      document; used by pendingEdits on accept
 *   6. `cleanChatContent` — strip internal jargon from chat before showing it
 *
 * If you're adding support for a new LLM edit format, this is the file to
 * look at first. Keep it pure — anything that touches disk belongs in
 * `features/pendingEdits/`.
 */

export interface EditOp {
  old_string: string;
  new_string: string;
  occurrence?: number;
}

export interface ParseResult {
  edits: EditOp[];
  chatContent: string;
}

export interface ValidationResult {
  ok: boolean;
  failures: string[];
}

export interface LocateResult {
  ok: boolean;
  count: number;
  contexts: string[];
}

export function parseEditBlocks(text: string): ParseResult {
  const regex = /```myst_edit\s*\n([\s\S]*?)```/g;
  const edits: EditOp[] = [];
  let chatContent = text;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const raw = match[1]!.trim();
      const parsed = JSON.parse(raw) as {
        old_string?: string;
        new_string?: string;
        occurrence?: number;
      };
      if (typeof parsed.old_string === 'string' && typeof parsed.new_string === 'string') {
        // Drop no-op edits (both sides empty) — they can't be applied and
        // would surface as a ghost "empty" pending edit in the UI.
        if (parsed.old_string === '' && parsed.new_string === '') {
          // skip
        } else {
          const op: EditOp = {
            old_string: parsed.old_string,
            new_string: parsed.new_string,
          };
          if (typeof parsed.occurrence === 'number' && parsed.occurrence > 0) {
            op.occurrence = parsed.occurrence;
          }
          edits.push(op);
        }
      }
    } catch {
      // swallow malformed JSON; caller handles empty edits list.
    }
    chatContent = chatContent.replace(match[0], '');
  }

  chatContent = chatContent.replace(/\n{3,}/g, '\n\n').trim();
  return { edits, chatContent };
}

export function locateEdit(doc: string, edit: EditOp): LocateResult {
  if (edit.old_string === '') return { ok: true, count: 1, contexts: [] };
  const contexts: string[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = doc.indexOf(edit.old_string, searchFrom);
    if (idx === -1) break;
    const start = Math.max(0, idx - 20);
    const end = Math.min(doc.length, idx + edit.old_string.length + 20);
    contexts.push(doc.slice(start, end).replace(/\n/g, ' '));
    searchFrom = idx + edit.old_string.length;
  }
  return { ok: contexts.length === 1, count: contexts.length, contexts };
}

export function validateEdits(doc: string, edits: EditOp[]): ValidationResult {
  const failures: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    if (edit.old_string === '') continue;
    const loc = locateEdit(doc, edit);
    if (loc.count === 0) {
      // Exact miss — give the accept-time fallback chain a shot before
      // failing. If any path (canonical/fuzzy/anchored) can locate the edit,
      // pre-flight should pass so we don't force a needless LLM retry.
      if (canLocateEdit(doc, edit)) continue;
      failures.push(
        `Edit ${i}: old_string not found. old_string: "${edit.old_string.slice(0, 80)}"`,
      );
    } else if (loc.count > 1) {
      if (edit.occurrence && edit.occurrence >= 1 && edit.occurrence <= loc.count) continue;
      const ctxList = loc.contexts.map((c, j) => `  ${j + 1}. "${c}"`).join('\n');
      failures.push(
        `Edit ${i}: old_string matches ${loc.count} places. Re-emit with an "occurrence" field set to 1-${loc.count}.\nMatches:\n${ctxList}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Can this edit be applied by *any* path — exact, canonical, whitespace-fuzzy,
 * or anchored? Used as a pre-flight so a broken old_string never reaches the
 * pending-edits staging area and then fails at accept time. Honours the
 * `occurrence` field so an out-of-range occurrence is rejected even if the
 * snippet itself appears in the doc.
 */
export function canLocateEdit(doc: string, edit: EditOp): boolean {
  if (edit.old_string === '') return true;
  const occ = edit.occurrence ?? 1;
  const loc = locateEdit(doc, edit);
  if (loc.count >= occ) return true;
  if (applyEditOccurrenceCanonical(doc, edit.old_string, '', occ) !== null) return true;
  if (applyEditOccurrenceFuzzy(doc, edit.old_string, '', occ) !== null) return true;
  if (applyEditOccurrenceAnchored(doc, edit.old_string, '', occ) !== null) return true;
  return false;
}

export function applyEditOccurrence(
  doc: string,
  oldString: string,
  newString: string,
  occurrence: number,
): string | null {
  if (oldString === '') {
    const trimmed = doc.trimEnd();
    if (trimmed.length === 0) return newString + '\n';
    return trimmed + '\n\n' + newString + '\n';
  }
  let idx = -1;
  let nth = 0;
  let searchFrom = 0;
  while (nth < occurrence) {
    idx = doc.indexOf(oldString, searchFrom);
    if (idx === -1) return null;
    nth++;
    if (nth < occurrence) searchFrom = idx + oldString.length;
  }
  return doc.slice(0, idx) + newString + doc.slice(idx + oldString.length);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whitespace-tolerant variant of applyEditOccurrence. Used as a fallback when
 * the exact match fails, which usually means whitespace drift: the LLM sent an
 * old_string with a single space where the file on disk has a newline (or
 * vice versa), or tiptap's markdown round-trip collapsed "  " into " ". Any
 * run of whitespace in oldString matches any run of whitespace in the doc.
 * Leading/trailing whitespace in oldString is ignored for locating, then we
 * splice back exactly over the matched range.
 */
export function applyEditOccurrenceFuzzy(
  doc: string,
  oldString: string,
  newString: string,
  occurrence: number,
): string | null {
  if (oldString === '') return null; // append has no fuzzy mode
  const trimmedNeedle = oldString.replace(/^\s+|\s+$/g, '');
  if (trimmedNeedle.length === 0) return null;

  // Build a regex: split on any whitespace, escape literals, rejoin with \s+.
  const parts = trimmedNeedle.split(/\s+/).map(escapeRegex);
  const pattern = new RegExp(parts.join('\\s+'), 'g');

  let match: RegExpExecArray | null;
  let nth = 0;
  while ((match = pattern.exec(doc)) !== null) {
    nth++;
    if (nth === occurrence) {
      const start = match.index;
      const end = start + match[0].length;
      return doc.slice(0, start) + newString + doc.slice(end);
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return null;
}

/**
 * Canonicalize the narrow set of typographic drift that breaks exact matching:
 * smart quotes, en/em dashes, non-breaking spaces, CRLF line endings, and
 * zero-width characters. Per-char, 1:1 (or 1:0 for dropped zero-widths, 2:1
 * for CRLF — both tracked by the position map so a match in canonical space
 * can be spliced back onto the raw doc).
 *
 * Deliberately narrow — no NFKC, no case folding, no markdown awareness. The
 * anchored path handles markdown drift; this handles "LLM typed straight
 * quotes where the doc has curly ones", which is the most common way a
 * semantically-correct edit fails exact indexOf.
 */
function canonicalChar(ch: string): string | null {
  switch (ch) {
    case '\u2018': case '\u2019': case '\u201A': case '\u2032':
      return "'";
    case '\u201C': case '\u201D': case '\u201E': case '\u2033':
      return '"';
    case '\u2013': case '\u2014': case '\u2212':
      return '-';
    case '\u00A0': case '\u2007': case '\u202F':
      return ' ';
    case '\u200B': case '\u200C': case '\u200D': case '\uFEFF':
      return '';
    default:
      return null;
  }
}

function buildCanonicalView(doc: string): { canonical: string; rawPos: number[] } {
  const out: string[] = [];
  const rawPos: number[] = [];
  let i = 0;
  while (i < doc.length) {
    const ch = doc[i]!;
    if (ch === '\r' && doc[i + 1] === '\n') {
      out.push('\n');
      rawPos.push(i);
      i += 2;
      continue;
    }
    const mapped = canonicalChar(ch);
    if (mapped === '') {
      i++;
      continue;
    }
    out.push(mapped ?? ch);
    rawPos.push(i);
    i++;
  }
  return { canonical: out.join(''), rawPos };
}

/**
 * Canonical-form accept fallback. Runs between the exact and whitespace-fuzzy
 * passes. Handles the most common silent drift: smart-vs-straight quotes, en/
 * em dashes, NBSP, CRLF — noise that otherwise forces the last-resort anchored
 * path (or fails outright).
 */
export function applyEditOccurrenceCanonical(
  doc: string,
  oldString: string,
  newString: string,
  occurrence: number,
): string | null {
  if (oldString === '') return null;
  const { canonical: docCanon, rawPos } = buildCanonicalView(doc);
  const { canonical: oldCanon } = buildCanonicalView(oldString);
  if (oldCanon.length === 0) return null;
  // Nothing to canonicalize — leave this case to the plain path.
  if (docCanon === doc && oldCanon === oldString) return null;

  let idx = -1;
  let nth = 0;
  let searchFrom = 0;
  while (nth < occurrence) {
    idx = docCanon.indexOf(oldCanon, searchFrom);
    if (idx === -1) return null;
    nth++;
    if (nth < occurrence) searchFrom = idx + oldCanon.length;
  }

  const startRaw = rawPos[idx];
  const lastCanonIdx = idx + oldCanon.length - 1;
  const lastRaw = rawPos[lastCanonIdx];
  if (startRaw === undefined || lastRaw === undefined) return null;
  // If the last emitted canonical char came from a CRLF pair, advance past \n.
  const endRaw = doc[lastRaw] === '\r' && doc[lastRaw + 1] === '\n' ? lastRaw + 2 : lastRaw + 1;
  return doc.slice(0, startRaw) + newString + doc.slice(endRaw);
}

/**
 * Normalize text to a "plain reading form" for anchor matching: strip inline
 * markdown markers (bold, italic, code, links, strikethrough, escapes) and
 * collapse whitespace runs into single spaces. Used only for locating anchor
 * points — the actual replacement still happens on the raw doc via the
 * positions recovered from the position map.
 */
function normalizeForAnchor(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a normalized view of `doc` plus a map from each normalized char index
 * back to the raw doc position, so a match found in normalized space can be
 * spliced back onto the original markdown.
 */
function buildNormalizedView(doc: string): { normalized: string; rawPos: number[] } {
  const norm: string[] = [];
  const rawPos: number[] = [];
  let i = 0;
  let lastEmittedSpace = false;

  const skipMarker = (len: number): void => {
    i += len;
  };
  const emitChar = (ch: string, srcIdx: number): void => {
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (lastEmittedSpace || norm.length === 0) {
        return;
      }
      norm.push(' ');
      rawPos.push(srcIdx);
      lastEmittedSpace = true;
    } else {
      norm.push(ch);
      rawPos.push(srcIdx);
      lastEmittedSpace = false;
    }
  };

  while (i < doc.length) {
    const rest = doc.slice(i);

    // ![alt](url) — image
    let m = /^!\[([^\]]*)\]\([^)]*\)/.exec(rest);
    if (m) {
      const alt = m[1]!;
      const altStart = i + 2;
      for (let k = 0; k < alt.length; k++) emitChar(alt[k]!, altStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // [text](url) — link
    m = /^\[([^\]]+)\]\([^)]*\)/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 1;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // [text][ref] — reference link
    m = /^\[([^\]]+)\]\[[^\]]*\]/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 1;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // `code`
    m = /^`([^`]+)`/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 1;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // ~~strike~~
    m = /^~~([^~]+)~~/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 2;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // **bold**
    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 2;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // __bold__
    m = /^__([^_]+)__/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 2;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // *italic*
    m = /^\*([^*\n]+)\*/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 1;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // _italic_
    m = /^_([^_\n]+)_/.exec(rest);
    if (m) {
      const text = m[1]!;
      const textStart = i + 1;
      for (let k = 0; k < text.length; k++) emitChar(text[k]!, textStart + k);
      skipMarker(m[0].length);
      continue;
    }
    // \escape
    m = /^\\([\\`*_{}[\]()#+\-.!])/.exec(rest);
    if (m) {
      emitChar(m[1]!, i + 1);
      skipMarker(m[0].length);
      continue;
    }

    emitChar(doc[i]!, i);
    i++;
  }

  // Trim leading/trailing whitespace chars without losing position info.
  while (norm.length > 0 && norm[0] === ' ') {
    norm.shift();
    rawPos.shift();
  }
  while (norm.length > 0 && norm[norm.length - 1] === ' ') {
    norm.pop();
    rawPos.pop();
  }

  return { normalized: norm.join(''), rawPos };
}

/**
 * Last-resort accept fallback. When exact and whitespace-fuzzy matching both
 * fail, match on a *prefix + suffix anchor* in normalized (markdown-stripped,
 * whitespace-collapsed) space. The typical failure: LLM's old_string is a
 * 1000-char paragraph whose body is correct but one embedded link/italic
 * differs slightly from the doc. Anchoring on the first and last ~40 chars
 * of plain text reliably finds the range, and we splice back onto the raw
 * doc using the position map.
 *
 * Safeguards:
 *   - `oldString` must be long enough that anchors are unambiguous (≥ 60 chars).
 *   - The prefix anchor must locate; the suffix anchor must locate *after* the
 *     prefix in the same normalized view.
 *   - For multi-occurrence cases, we honour `occurrence` by scanning normalized
 *     space left-to-right.
 */
export function applyEditOccurrenceAnchored(
  doc: string,
  oldString: string,
  newString: string,
  occurrence: number,
): string | null {
  if (oldString === '') return null;

  const oldNorm = normalizeForAnchor(oldString);
  if (oldNorm.length < 60) return null;

  const anchorLen = Math.min(40, Math.floor(oldNorm.length / 3));
  const prefixNorm = oldNorm.slice(0, anchorLen);
  const suffixNorm = oldNorm.slice(-anchorLen);

  const { normalized: docNorm, rawPos } = buildNormalizedView(doc);
  if (docNorm.length === 0) return null;

  // Find the nth prefix occurrence.
  let prefixIdx = -1;
  let nth = 0;
  let searchFrom = 0;
  while (nth < occurrence) {
    prefixIdx = docNorm.indexOf(prefixNorm, searchFrom);
    if (prefixIdx === -1) return null;
    nth++;
    if (nth < occurrence) searchFrom = prefixIdx + 1;
  }

  // Find the next suffix occurrence after the prefix end.
  const minSuffixStart = prefixIdx + prefixNorm.length - 1;
  const suffixIdx = docNorm.indexOf(suffixNorm, Math.max(0, minSuffixStart - anchorLen));
  if (suffixIdx === -1 || suffixIdx < prefixIdx) return null;

  const startRaw = rawPos[prefixIdx];
  const lastNormIdx = suffixIdx + suffixNorm.length - 1;
  const lastRaw = rawPos[lastNormIdx];
  if (startRaw === undefined || lastRaw === undefined) return null;
  const endRaw = lastRaw + 1;
  if (endRaw <= startRaw) return null;

  return doc.slice(0, startRaw) + newString + doc.slice(endRaw);
}

const CHANGE_WORDS = /\b(changed|updated|switched|swapped|renamed|replaced|tweaked|edited|modified|added|wrote|dropped|inserted|promotion|start|here'?s)\b/i;
const REQUEST_WORDS = /\b(write|create|add|change|rename|edit|fix|rewrite|make|extend|continue|update|swap|replace|remove|delete)\b/i;

export function looksLikeDocumentRequest(userText: string, llmResponse: string): boolean {
  return REQUEST_WORDS.test(userText) || CHANGE_WORDS.test(llmResponse);
}

export interface PendingLike {
  oldString: string;
  newString: string;
  occurrence: number;
}

/**
 * Merge a freshly-staged batch into the existing pending list, treating a new
 * edit whose (oldString, occurrence) matches an existing one as a REVISION
 * (same slot, new newString) instead of a second entry. This lets the user
 * say "make it shorter" in chat and have the LLM update the pending edit in
 * place rather than piling up parallel pending entries.
 *
 * Append-mode edits (oldString === '') all collide with each other, since
 * there's no way to tell which append the user means — so a new append
 * replaces the most recent existing append.
 */
export function mergePendingEdits<
  T extends PendingLike,
  U extends PendingLike,
>(existing: T[], incoming: U[], makeNew: (u: U) => T): T[] {
  const result = [...existing];
  for (const inc of incoming) {
    const matchIdx = result.findIndex(
      (e) => e.oldString === inc.oldString && e.occurrence === inc.occurrence,
    );
    if (matchIdx >= 0) {
      const prev = result[matchIdx]!;
      result[matchIdx] = { ...prev, newString: inc.newString };
    } else {
      result.push(makeNew(inc));
    }
  }
  return result;
}

/**
 * Try to resolve an edit against the text of existing pending edits (not
 * against the document). Used when the LLM emits a sub-edit whose old_string
 * isn't in the doc yet — it's inside a pending edit's new_string — because the
 * user is asking to revise the pending content before accepting it. Returns
 * the index of the first pending edit that contains oldString (with the given
 * occurrence) and the patched newString.
 */
export function tryResolvePendingPatch(
  oldString: string,
  newString: string,
  occurrence: number,
  pending: Array<{ newString: string }>,
): { index: number; updatedNewString: string } | null {
  if (oldString === '') return null;
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    if (!entry) continue;
    const result = applyEditOccurrence(entry.newString, oldString, newString, occurrence);
    if (result !== null) {
      return { index: i, updatedNewString: result };
    }
  }
  return null;
}

export function cleanChatContent(text: string): string {
  return text
    .replace(/```myst_edit\s*\n[\s\S]*?```/g, '')
    .replace(/`myst_edit`/gi, '')
    .replace(/myst_edit/gi, '')
    .replace(/old_string/g, '')
    .replace(/new_string/g, '')
    // Strip chain-of-thought / channel markers from reasoning-tuned models.
    // Some OpenRouter models (various gemma / qwen / glm variants) leak raw
    // `<|channel|>thought ... <|channel|>final` or `<think>...</think>` style
    // tokens into the stream. These aren't intended for the user.
    .replace(/<\|channel\|?>[\s\S]*?<\/?channel\|?>/gi, '')
    .replace(/<\|(?:channel|thinking|thought|reasoning|assistant|system|user)[^>]*\|?>/gi, '')
    .replace(/<\/?(?:channel|thinking|thought|reasoning)\|?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
