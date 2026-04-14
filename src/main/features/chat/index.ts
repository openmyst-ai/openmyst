import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type { ChatMessage } from '@shared/types';
import { broadcast, log, logError, readProjectFile } from '../../platform';
import { getOpenRouterKey, getSettings } from '../settings';
import { readDocument } from '../documents';
import { readWikiIndex, updateWikiIndex } from '../wiki';
import { listSources } from '../sources';
import { appendMessage, clearHistory, loadHistory } from './persistence';
import { runTurn } from './turn';

/**
 * Chat feature entry point. The renderer calls `sendMessage` with the user's
 * text and the currently-open document; this file assembles the per-turn
 * context (API key, model, agent prompt, doc text, wiki index) and hands it
 * off to `runTurn` for the actual LLM orchestration.
 *
 * The split between this file and turn.ts is deliberate: everything that
 * depends on ambient state — settings, disk reads, the user message append —
 * lives here; everything that is "given these inputs, run a turn" lives in
 * turn.ts. That makes runTurn easier to reason about and, eventually, easier
 * to test without needing a real project on disk.
 */

export { clearHistory, loadHistory } from './persistence';

export async function sendMessage(
  userText: string,
  activeDocument: string,
  displayText?: string,
): Promise<ChatMessage> {
  log('chat', 'send.received', {
    doc: activeDocument,
    userText,
    displayText: displayText ?? null,
    userTextChars: userText.length,
  });

  const apiKey = await getOpenRouterKey();
  if (!apiKey) throw new Error('OpenRouter API key not set. Add it in Settings.');

  const settings = await getSettings();
  const model = settings.defaultModel;

  const agentPrompt = await readProjectFile('agent.md');
  const document = await readDocument(activeDocument);
  // Refresh the wiki index from current sources before every turn. Cheap
  // (just enumerates sources/*.meta.json and rewrites one file), and it
  // guarantees the index reflects the latest format — important right now
  // because we just slimmed it down to summaries-only.
  await updateWikiIndex(await listSources());
  const wikiIndex = await readWikiIndex();
  const docLabel = activeDocument.replace(/\.md$/, '');

  // `displayText` is what the user sees in chat history; `userText` is what
  // the LLM sees for this turn. When they differ (e.g. Ask Myst from a
  // comment), the raw prompt scaffolding stays out of the visible thread.
  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: displayText ?? userText,
    timestamp: new Date().toISOString(),
  };
  await appendMessage(userMsg);
  // Tell the renderer a new turn has started so it can show the user message
  // + typing indicator immediately, before the first chunk arrives.
  broadcast(IpcChannels.Chat.Started);

  try {
    return await runTurn({
      apiKey,
      model,
      agentPrompt,
      document,
      wikiIndex,
      docLabel,
      activeDocument,
      userText,
      displayText,
    });
  } catch (err) {
    const message = (err as Error).message ?? 'Unknown error';
    logError('chat', 'send.failed', err);
    const errorMsg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: `⚠️ ${message}`,
      timestamp: new Date().toISOString(),
    };
    await appendMessage(errorMsg);
    return errorMsg;
  } finally {
    // Always unblock the renderer UI — even on error.
    broadcast(IpcChannels.Chat.ChunkDone);
  }
}

