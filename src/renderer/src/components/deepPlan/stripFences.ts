const BLOCK_TAGS = ['rubric_update', 'research_plan', 'source_lookup'] as const;

/**
 * Strip structured fenced blocks from planner output before showing to the
 * user. Handles:
 *  - complete `rubric_update` / `research_plan` / `source_lookup` fences
 *  - a trailing in-progress (unclosed) fence mid-stream — so users don't
 *    see half a JSON blob being typed out
 *  - a bare trailing JSON object/array on its own line (the "forgot the
 *    fence" failure mode — parser strips this server-side too, but this
 *    is belt-and-braces for streaming and any un-patched legacy messages)
 *
 * Returns `isWriting` when there's an open fence (or an open trailing
 * brace that looks like it's starting a JSON block) so the UI can swap
 * in a "thinking" indicator instead of showing structured junk.
 */
export function stripDeepPlanFences(text: string): { visible: string; isWriting: boolean } {
  let visible = text;
  for (const tag of BLOCK_TAGS) {
    const fullRe = new RegExp('```' + tag + '\\s*\\n[\\s\\S]*?```', 'g');
    visible = visible.replace(fullRe, '');
  }

  let isWriting = false;
  for (const tag of BLOCK_TAGS) {
    const openTag = '```' + tag;
    const partialIdx = visible.lastIndexOf(openTag);
    if (partialIdx === -1) continue;
    const afterPartial = visible.slice(partialIdx + openTag.length);
    if (!afterPartial.includes('```')) {
      visible = visible.slice(0, partialIdx);
      isWriting = true;
    }
  }

  // Bare-JSON fallback: a line that opens with `{` or `[` at the end of
  // the message (preceded by blank-line separation) is almost always the
  // model forgetting the fence. If we can balance the braces, strip the
  // whole block; if we can't, treat it as an in-progress write and hide
  // it so the user sees "thinking" instead of half a brace.
  const bareStart = findTrailingBareJsonStart(visible);
  if (bareStart !== null) {
    const after = visible.slice(bareStart);
    if (isBalancedJson(after)) {
      visible = visible.slice(0, bareStart);
    } else {
      visible = visible.slice(0, bareStart);
      isWriting = true;
    }
  }

  return { visible: visible.replace(/\n{3,}/g, '\n\n').trim(), isWriting };
}

function findTrailingBareJsonStart(text: string): number | null {
  // Walk backwards over trailing whitespace, then from the last non-space
  // char look for a `{` or `[` that starts on its own line with a blank
  // line separating it from the prose above. This is narrow on purpose —
  // we don't want to strip inline code samples in mid-message prose.
  const trimmedEnd = text.replace(/\s+$/, '').length;
  if (trimmedEnd === 0) return null;
  // Find the last newline before trimmedEnd; the candidate starts after it.
  // We accept either a fully-closed block (`{...}` trailing) or a
  // streaming-in-progress open (just `{` with content still coming).
  // Scan backwards for the first `{` or `[` that is at column 0 (start
  // of line) and preceded by a blank line (or start-of-text).
  let i = trimmedEnd - 1;
  while (i >= 0) {
    const lineStart = text.lastIndexOf('\n', i) + 1;
    const lineFirst = text[lineStart];
    if (lineFirst === '{' || lineFirst === '[') {
      const before = text.slice(0, lineStart);
      const endsBlank = before.length === 0 || /\n\s*\n\s*$/.test(before) || /\n$/.test(before);
      if (endsBlank) return lineStart;
    }
    if (lineStart === 0) return null;
    i = lineStart - 2;
  }
  return null;
}

function isBalancedJson(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
}
