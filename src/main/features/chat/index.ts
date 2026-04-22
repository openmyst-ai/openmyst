import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type { ChatMessage } from '@shared/types';
import { broadcast, log, logError, readProjectFile } from '../../platform';
import { ensureLlmReady } from '../../llm';
import { getSettings } from '../settings';
import { readDocument } from '../documents';
import { readWikiIndex, updateWikiIndex } from '../wiki';
import { listSources } from '../sources';
import { readSession as readDeepPlanSession } from '../deepPlan/state';
import { readState as readDeepSearchState } from '../deepSearch/state';
import { appendMessage, clearHistory, loadHistory } from './persistence';
import { runTurn } from './turn';
import type { PlanLookupPayload } from './contextLookups';

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

  await ensureLlmReady();

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

  // Pull the Deep Plan plan.md + requirements (if any) so the agent keeps
  // the thesis, section structure, and hard constraints in view across
  // sessions. Skipped plans don't inject — the user explicitly opted out.
  const deepPlanSession = await readDeepPlanSession().catch(() => null);
  const plan: PlanLookupPayload | null =
    deepPlanSession && !deepPlanSession.skipped
      ? {
          task: deepPlanSession.task,
          requirements: deepPlanSession.requirements,
          vision: deepPlanSession.vision,
          anchorLogSize: deepPlanSession.anchorLog.length,
        }
      : null;

  // Research queries from the Deep Search side so the agent knows what's
  // already been asked. (Deep Plan no longer persists a query list — the
  // panel dispatches them inline; searchesUsed is a counter only.)
  const deepSearchState = await readDeepSearchState().catch(() => null);
  const researchQueries: string[] = [];
  const seen = new Set<string>();
  for (const q of deepSearchState?.queries ?? []) {
    const key = q.query.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    researchQueries.push(q.query);
  }

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
      model,
      agentPrompt,
      document,
      wikiIndex,
      docLabel,
      activeDocument,
      userText,
      displayText,
      plan,
      researchQueries,
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

