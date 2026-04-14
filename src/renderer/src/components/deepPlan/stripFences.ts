const BLOCK_TAGS = ['rubric_update', 'research_plan', 'source_lookup'] as const;

/**
 * Strip structured fenced blocks from planner output before showing to the
 * user. Handles both complete blocks and a trailing in-progress (unclosed)
 * fence — the latter is what leaks into the streaming buffer mid-generation.
 *
 * Returns `isWriting` when there's an open fence we're waiting on, so the UI
 * can swap in a "thinking" indicator instead of showing half a JSON blob.
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

  return { visible: visible.replace(/\n{3,}/g, '\n\n').trim(), isWriting };
}
