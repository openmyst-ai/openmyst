import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { PendingEdit } from '@shared/types';
import { renderMarkdown, renderMarkdownInline } from '../utils/markdown';
import { usePendingEdits } from '../store/pendingEdits';

export const pendingEditsKey = new PluginKey<PendingEditsState>('pendingEdits');

interface PendingRange {
  from: number;
  to: number;
}

interface PendingEditsState {
  decorations: DecorationSet;
  deleteRanges: PendingRange[];
  activeEditId: string | null;
}

interface FlatDoc {
  flat: string;
  posMap: number[];
}

function buildFlatText(doc: PmNode): FlatDoc {
  const parts: string[] = [];
  const posMap: number[] = [];
  let first = true;

  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (!first) {
        parts.push('\n');
        posMap.push(pos);
      }
      first = false;
      let childOffset = 1;
      node.forEach((child) => {
        if (child.isText && child.text) {
          const text = child.text;
          parts.push(text);
          for (let i = 0; i < text.length; i++) {
            posMap.push(pos + childOffset + i);
          }
        }
        childOffset += child.nodeSize;
      });
      return false;
    }
    return undefined;
  });

  return { flat: parts.join(''), posMap };
}

function locateOccurrence(haystack: string, needle: string, occurrence: number): number | null {
  if (needle.length === 0) return null;
  let searchFrom = 0;
  let hit = -1;
  for (let n = 0; n < occurrence; n++) {
    hit = haystack.indexOf(needle, searchFrom);
    if (hit === -1) return null;
    searchFrom = hit + needle.length;
  }
  return hit;
}

function rangeFromFlatHit(
  startFlat: number,
  needleLen: number,
  posMap: number[],
): PendingRange | null {
  const endFlat = startFlat + needleLen - 1;
  const fromPos = posMap[startFlat];
  const lastPos = posMap[endFlat];
  if (fromPos === undefined || lastPos === undefined) return null;
  const toPos = lastPos + 1;
  if (toPos <= fromPos) return null;
  return { from: fromPos, to: toPos };
}

/**
 * Strip leading markdown line markers (`#`, `##`, `-`, `*`, `1.`, `>`, etc.)
 * from each line. Used as a fallback when the exact oldString doesn't match
 * the PM flat text — because PM strips markdown syntax, so an LLM-emitted
 * `# Heading` lives as `Heading` inside the heading node.
 */
function stripMarkdownLinePrefixes(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)+/, ''))
    .join('\n');
}

/**
 * Collapse blank-line paragraph breaks to single newlines. PM's flat text puts
 * one `\n` between textblocks, but LLM-emitted old_strings virtually always
 * separate paragraphs with `\n\n` (the canonical markdown form). Without this
 * normalization any multi-paragraph edit silently fails to locate — no red/
 * green decorations render — yet accept still works because it runs against
 * the raw file on disk. Also trims trailing whitespace on each line so
 * "  \n" doesn't block a match.
 */
function collapseBlankLines(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n');
}

/**
 * Strip *inline* markdown markers so a paragraph containing `**bold**`,
 * `*italic*`, `` `code` ``, or `[text](url)` can still match PM's flat text,
 * which has all of those stripped to their visible form. Without this fallback,
 * any edit whose old_string contains inline formatting silently fails to
 * render the red/green diff even though accept (which works on the raw file)
 * succeeds.
 *
 * Handled cases, in order:
 *   - `[text](url)` and `[text][ref]` → `text` (link markers)
 *   - `![alt](url)` → `alt` (image markers — rare in edits but cheap to cover)
 *   - ``code``     → `code` (inline code)
 *   - `**x**`, `__x__`, `*x*`, `_x_` → `x` (bold/italic)
 *   - `~~x~~` → `x` (strikethrough)
 *   - `\*` / `\_` / `\[` etc. → dropped backslash (markdown escapes)
 */
function stripMarkdownInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
}

function findPendingEditRange(
  doc: PmNode,
  oldString: string,
  occurrence: number,
): PendingRange | null {
  if (oldString === '') return null;
  const { flat, posMap } = buildFlatText(doc);
  if (flat.length === 0) return null;

  // Walk the Nth occurrence in the flattened string — single-line or
  // multi-line — then map back to PM positions via posMap.
  const exact = locateOccurrence(flat, oldString, occurrence);
  if (exact !== null) {
    return rangeFromFlatHit(exact, oldString.length, posMap);
  }

  // Fallback 1: strip markdown line markers from the needle. Without this, a
  // pending edit whose old_string is `# Physics Story` can't be located in a
  // PM doc whose flat text is `Physics Story`, so the diff widget silently
  // renders nothing — even though accept (which runs on the raw file on disk)
  // succeeds. Covers the common heading/list/blockquote-prefix cases.
  const linesStripped = stripMarkdownLinePrefixes(oldString);
  if (linesStripped !== oldString && linesStripped.length > 0) {
    const fuzzy = locateOccurrence(flat, linesStripped, occurrence);
    if (fuzzy !== null) {
      return rangeFromFlatHit(fuzzy, linesStripped.length, posMap);
    }
  }

  // Fallback 2: also strip inline markdown markers (bold/italic/code/link).
  // "Rewrite this to 50 words" edits are the common trigger — the LLM copies
  // a whole paragraph into old_string, and any `**word**` or `[link](url)` in
  // it breaks the match against PM's flat text.
  const fullyStripped = stripMarkdownInline(linesStripped);
  if (fullyStripped !== linesStripped && fullyStripped.length > 0) {
    const fuzzy = locateOccurrence(flat, fullyStripped, occurrence);
    if (fuzzy !== null) {
      return rangeFromFlatHit(fuzzy, fullyStripped.length, posMap);
    }
  }

  // Fallback 3: collapse paragraph-break blank lines (`\n\n` → `\n`). PM's
  // flat text only puts a single `\n` between textblocks, so any multi-
  // paragraph old_string fails the exact match. This is the single biggest
  // source of "empty diff but accept works" bug reports.
  const collapsed = collapseBlankLines(fullyStripped);
  if (collapsed !== fullyStripped && collapsed.length > 0) {
    const fuzzy = locateOccurrence(flat, collapsed, occurrence);
    if (fuzzy !== null) {
      return rangeFromFlatHit(fuzzy, collapsed.length, posMap);
    }
  }
  return null;
}

/**
 * True if `source` contains any markdown construct that only renders correctly
 * through the block pipeline (headings, lists, blockquotes, tables, fenced
 * code, horizontal rules) or spans multiple paragraphs. Inline-rendered diffs
 * show those as literal `#`/`-`/`>` chars, which is what users were flagging.
 */
function hasBlockMarkdown(source: string): boolean {
  if (/\n\s*\n/.test(source)) return true;
  for (const line of source.split('\n')) {
    const trimmed = line.replace(/^\s+/, '');
    if (/^#{1,6}\s/.test(trimmed)) return true;
    if (/^[-*+]\s/.test(trimmed)) return true;
    if (/^\d+\.\s/.test(trimmed)) return true;
    if (/^>\s?/.test(trimmed)) return true;
    if (/^```/.test(trimmed)) return true;
    if (/^\|.*\|/.test(trimmed)) return true;
    if (/^(?:-{3,}|_{3,}|\*{3,})\s*$/.test(trimmed)) return true;
  }
  return false;
}

function quickHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h.toString(36);
}

function buildState(doc: PmNode, edits: PendingEdit[]): PendingEditsState {
  const decos: Decoration[] = [];
  const deleteRanges: PendingRange[] = [];

  // Only the first (active) edit gets decorated.
  const active = edits[0] ?? null;
  if (!active) {
    return { decorations: DecorationSet.empty, deleteRanges: [], activeEditId: null };
  }

  // Key includes a hash of newString so that when the user (or LLM) patches the
  // pending content, PM invalidates the cached widget and we re-render the
  // markdown from the fresh source. Without this the same key would short-
  // circuit toDOM and the diff would stay stale.
  const widgetKey = `pending-${active.id}-${quickHash(active.newString)}`;
  const widgetSpec = {
    key: widgetKey,
    side: 1,
    ignoreSelection: true,
    stopEvent: () => true,
  };

  if (active.oldString === '') {
    const widget = Decoration.widget(
      doc.content.size,
      () => buildInsertWidget(active, true),
      widgetSpec,
    );
    decos.push(widget);
    return {
      decorations: DecorationSet.create(doc, decos),
      deleteRanges: [],
      activeEditId: active.id,
    };
  }

  const range = findPendingEditRange(doc, active.oldString, active.occurrence);
  if (!range) {
    return { decorations: DecorationSet.empty, deleteRanges: [], activeEditId: active.id };
  }

  deleteRanges.push(range);
  decos.push(
    Decoration.inline(range.from, range.to, {
      class: 'pending-delete',
      'data-pending-id': active.id,
    }),
  );
  decos.push(
    Decoration.widget(range.to, () => buildInsertWidget(active, false), widgetSpec),
  );

  return {
    decorations: DecorationSet.create(doc, decos),
    deleteRanges,
    activeEditId: active.id,
  };
}

/**
 * Build the green-diff insert widget. Renders edit.newString as markdown (with
 * KaTeX-rendered math via the shared mystMarkdown instance). Click to edit: the
 * rendered body is swapped for a textarea showing the raw markdown source; on
 * blur we commit via `usePendingEdits.patch()`, which flows through the IPC
 * patch channel and writes back to .myst/pending/<doc>.json.
 */
function buildInsertWidget(edit: PendingEdit, isAppend: boolean): HTMLElement {
  // A replacement whose new content contains block-level markdown (headings,
  // lists, blockquotes, multi-paragraph, fenced code…) must render through the
  // block pipeline, otherwise `#`, `-`, `>` etc. leak through as literal chars.
  // We flip to the block layout in that case even for non-append edits.
  const useBlock = isAppend || hasBlockMarkdown(edit.newString);
  const tag = useBlock ? 'div' : 'span';
  const container = document.createElement(tag);
  container.className = useBlock ? 'pending-insert pending-insert-append' : 'pending-insert';
  container.dataset['pendingId'] = edit.id;

  let currentValue = edit.newString;
  let editing = false;

  const renderRead = (): void => {
    container.innerHTML = '';
    const body = document.createElement(tag);
    body.className = 'pending-insert-text';
    body.dataset['pendingId'] = edit.id;
    body.title = 'Click to edit';
    if (currentValue.length === 0) {
      body.textContent = '(empty — click to write a replacement)';
      body.dataset['empty'] = 'true';
    } else if (useBlock) {
      // Append widgets sit on their own block, so full block rendering is
      // fine — headings, paragraphs, lists all flow naturally. Same path
      // also handles inline replacements whose new content is block-shaped.
      body.innerHTML = renderMarkdown(currentValue);
    } else {
      // Truly inline replacement (e.g. "Dingle" → "Pingle" mid-paragraph).
      // Block rendering would wrap in `<p>`, which forces line breaks inside
      // the host paragraph and leaves the strikethrough range looking like it
      // covers blank lines. renderInline skips the `<p>` wrap.
      body.innerHTML = renderMarkdownInline(currentValue);
    }
    body.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    body.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enterEditMode();
    });
    container.appendChild(body);
  };

  const enterEditMode = (): void => {
    if (editing) return;
    editing = true;
    container.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'pending-insert-textarea';
    ta.dataset['pendingId'] = edit.id;
    ta.value = currentValue;
    ta.spellcheck = true;
    const resize = (): void => {
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener('input', () => {
      currentValue = ta.value;
      resize();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        ta.blur();
      }
    });
    ta.addEventListener('blur', () => {
      commit();
    });
    container.appendChild(ta);
    // Defer focus so PM doesn't immediately steal it back via its own click
    // handler — stopEvent keeps PM out, but focus happens after the click
    // bubble completes.
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      resize();
    }, 0);
  };

  const commit = (): void => {
    if (!editing) return;
    editing = false;
    if (currentValue === edit.newString) {
      // Nothing changed — just swap back to read view without round-tripping
      // through IPC.
      renderRead();
      return;
    }
    // Fire-and-forget: the store update will trigger a widget rebuild with the
    // new hash key, replacing our DOM with a freshly rendered markdown view.
    void usePendingEdits.getState().patch(edit.id, currentValue);
  };

  renderRead();
  return container;
}

function mapRanges(ranges: PendingRange[], mapping: { map: (pos: number, assoc?: number) => number }): PendingRange[] {
  return ranges.map((r) => ({ from: mapping.map(r.from, -1), to: mapping.map(r.to, 1) }));
}

function trTouchesRanges(tr: { steps: Array<{ getMap: () => { forEach: (cb: (oldStart: number, oldEnd: number) => void) => void } }>; docChanged: boolean }, ranges: PendingRange[]): boolean {
  if (!tr.docChanged || ranges.length === 0) return false;
  let blocked = false;
  tr.steps.forEach((step) => {
    if (blocked) return;
    const map = step.getMap();
    map.forEach((oldStart: number, oldEnd: number) => {
      if (blocked) return;
      for (const r of ranges) {
        // Block if the step's affected range overlaps a pending-delete range.
        if (oldStart < r.to && oldEnd > r.from) {
          blocked = true;
          return;
        }
      }
    });
  });
  return blocked;
}

export function createPendingEditsExtension(): Extension {
  return Extension.create({
    name: 'pendingEdits',
    addProseMirrorPlugins() {
      return [
        new Plugin<PendingEditsState>({
          key: pendingEditsKey,
          state: {
            init() {
              return { decorations: DecorationSet.empty, deleteRanges: [], activeEditId: null };
            },
            apply(tr, old) {
              const meta = tr.getMeta(pendingEditsKey) as PendingEdit[] | undefined;
              if (meta !== undefined) {
                return buildState(tr.doc, meta);
              }
              return {
                decorations: old.decorations.map(tr.mapping, tr.doc),
                deleteRanges: mapRanges(old.deleteRanges, tr.mapping),
                activeEditId: old.activeEditId,
              };
            },
          },
          filterTransaction(tr, state) {
            const pluginState = pendingEditsKey.getState(state);
            if (!pluginState) return true;
            if (tr.getMeta(pendingEditsKey) !== undefined) return true;
            return !trTouchesRanges(tr, pluginState.deleteRanges);
          },
          props: {
            decorations(state) {
              return pendingEditsKey.getState(state)?.decorations ?? DecorationSet.empty;
            },
          },
        }),
      ];
    },
  });
}
