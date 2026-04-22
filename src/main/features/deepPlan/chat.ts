import type { DeepPlanSession, SourceMeta } from '@shared/types';
import { log, logError } from '../../platform';
import { completeText, type LlmMessage } from '../../llm';
import { getDeepPlanModel } from '../settings';
import { chairChatPrompt } from './prompts';

/**
 * Single-turn Chair reply in free-chat mode. Cheap path — one LLM call,
 * no panel fanout, no plan rewrite, no materialiser. The caller appends
 * the user's message and this reply to `session.messages` and optionally
 * accumulates the user's message into `pendingChatNotes` for the next
 * panel round.
 *
 * Returns the reply text on success, or null when the model call failed
 * or returned nothing usable. Callers surface a generic "I'm having
 * trouble replying" message in that case so the UI doesn't wedge.
 */
export async function runChairChat(args: {
  session: DeepPlanSession;
  sources: SourceMeta[];
  userMessage: string;
}): Promise<string | null> {
  const { session, sources, userMessage } = args;
  const model = await getDeepPlanModel();

  // Pull the last ~6 chat turns (user + chair) for context. Anything older
  // is covered by plan.md and the transcript the panel has already seen.
  const recentChat: { role: 'user' | 'chair'; text: string }[] = [];
  for (const m of session.messages) {
    if (m.kind === 'user-chat') {
      recentChat.push({ role: 'user', text: m.content });
    } else if (m.kind === 'chair-chat') {
      recentChat.push({ role: 'chair', text: m.content });
    }
  }
  const trimmedChat = recentChat.slice(-6);

  const systemPrompt = chairChatPrompt({
    session,
    sources,
    recentChat: trimmedChat,
    userMessage,
  });
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: 'Reply now — one or two short paragraphs, plain prose.',
    },
  ];

  try {
    const reply = await completeText({ model, messages, logScope: 'deep-plan' });
    if (!reply || reply.trim().length === 0) {
      log('deep-plan', 'chairChat.emptyReply', {});
      return null;
    }
    log('deep-plan', 'chairChat.done', {
      userChars: userMessage.length,
      replyChars: reply.length,
      historyTurns: trimmedChat.length,
    });
    return reply.trim();
  } catch (err) {
    logError('deep-plan', 'chairChat.failed', err);
    return null;
  }
}
