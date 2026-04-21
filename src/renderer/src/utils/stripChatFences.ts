const CHAT_FENCE_TAGS = [
  'myst_edit',
  'source_lookup',
  'web_search',
  'doc_lookup',
  'rubric_lookup',
  'queries_lookup',
] as const;

/**
 * Strip structured LLM fences from editor-chat output before it hits the
 * screen. Mirrors `stripDeepPlanFences` but over the chat-side fence set
 * (myst_edit + the five lookup types). Handles:
 *  - fully-closed fences — strip cleanly
 *  - an in-progress (unclosed) fence mid-stream — hide the tail, flag
 *    `isWriting` so the UI swaps in a thinking indicator
 *  - a trailing bare `{ slug: "..." }` / `{slug: '...'}` the model forgot
 *    to fence — strip it so the user doesn't see raw JSON
 *  - orphan backticks (```, ```s, ```sou) before the tag finishes streaming
 *    — these cause the "jittery slug" flicker and need to flip isWriting on
 */
export function stripChatFences(text: string): { visible: string; isWriting: boolean } {
  let visible = text;
  let isWriting = false;

  for (const tag of CHAT_FENCE_TAGS) {
    const fullRe = new RegExp('```' + tag + '\\s*\\n?[\\s\\S]*?```', 'g');
    visible = visible.replace(fullRe, '');
  }

  visible = visible.replace(
    /\{[^{}\n]*\bslug\s*:\s*["'][^"']*["'][^{}\n]*\}/g,
    '',
  );

  for (const tag of CHAT_FENCE_TAGS) {
    const openTag = '```' + tag;
    const partialIdx = visible.lastIndexOf(openTag);
    if (partialIdx === -1) continue;
    const afterPartial = visible.slice(partialIdx + openTag.length);
    if (!afterPartial.includes('```')) {
      visible = visible.slice(0, partialIdx);
      isWriting = true;
    }
  }

  const fenceCount = (visible.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    const lastFence = visible.lastIndexOf('```');
    if (lastFence !== -1) {
      visible = visible.slice(0, lastFence);
      isWriting = true;
    }
  }

  return { visible: visible.replace(/\n{3,}/g, '\n\n').trim(), isWriting };
}
