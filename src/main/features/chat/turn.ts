import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/ipc-channels';
import type { ChatMessage, PendingEdit } from '@shared/types';
import { broadcast, log } from '../../platform';
import { streamChat, type LlmMessage } from '../../llm';
import {
  addPendingEdits,
  listPendingEdits,
  patchPendingEditNewString,
} from '../pendingEdits';
import { readDocument } from '../documents';
import {
  formatLookupReply,
  parseSourceLookups,
  resolveSourceLookups,
} from '../sources/sourceLookup';
import {
  cleanChatContent,
  looksLikeDocumentRequest,
  parseEditBlocks,
  tryResolvePendingPatch,
  validateEdits,
  type EditOp,
} from './editLogic';
import { buildSystemPrompt } from './systemPrompt';
import { appendMessage, loadHistory } from './persistence';

const MAX_LOOKUP_ROUNDS = 3;

/**
 * A single chat turn, end-to-end. This is the orchestration loop — it calls
 * the LLM, parses the response, triages edits against the pending-edits
 * staging area, runs retries when validation fails, and finally stages the
 * surviving edits and persists the assistant reply.
 *
 * If you want to change *what* the LLM sees on a turn, edit systemPrompt.ts.
 * If you want to change *how* we react to its response (parse/triage/retry),
 * edit this file. The two concerns split cleanly in practice.
 */

export interface TurnContext {
  model: string;
  agentPrompt: string;
  document: string;
  wikiIndex: string;
  docLabel: string;
  activeDocument: string;
  userText: string;
  displayText: string | undefined;
}

async function listPendingEditsSafe(docFilename: string): Promise<PendingEdit[]> {
  try {
    return await listPendingEdits(docFilename);
  } catch {
    return [];
  }
}

async function stageEdits(docFilename: string, edits: EditOp[]): Promise<number> {
  if (edits.length === 0) return 0;
  await addPendingEdits(
    docFilename,
    edits.map((e) => {
      const entry: { oldString: string; newString: string; occurrence?: number } = {
        oldString: e.old_string,
        newString: e.new_string,
      };
      if (e.occurrence !== undefined) entry.occurrence = e.occurrence;
      return entry;
    }),
  );
  return edits.length;
}

interface TriageResult {
  remainingEdits: EditOp[];
  pendingPatched: number;
}

/**
 * An edit whose old_string references content from a pending edit (not yet
 * in the doc on disk) should patch that pending in place, not fail doc
 * validation. Critical for "write me X → make it shorter" where the story
 * only lives inside the pending newString so far.
 */
async function triageEditsAgainstPending(
  edits: EditOp[],
  existingPending: PendingEdit[],
  document: string,
  activeDocument: string,
): Promise<TriageResult> {
  if (edits.length === 0 || existingPending.length === 0) {
    return { remainingEdits: edits, pendingPatched: 0 };
  }
  const workingPending: PendingEdit[] = existingPending.map((e) => ({ ...e }));
  const remaining: EditOp[] = [];
  let pendingPatched = 0;
  for (const edit of edits) {
    if (edit.old_string === '' || document.indexOf(edit.old_string) !== -1) {
      log('chat', 'triage.doc', {
        reason: edit.old_string === '' ? 'append' : 'matched-doc',
        oldPreview: edit.old_string.slice(0, 60),
      });
      remaining.push(edit);
      continue;
    }
    const match = tryResolvePendingPatch(
      edit.old_string,
      edit.new_string,
      edit.occurrence ?? 1,
      workingPending,
    );
    if (match) {
      const target = workingPending[match.index]!;
      log('chat', 'triage.pendingPatch', {
        pendingId: target.id,
        index: match.index,
        oldPreview: edit.old_string.slice(0, 60),
        newPreview: edit.new_string.slice(0, 60),
        patchedLen: match.updatedNewString.length,
      });
      await patchPendingEditNewString(activeDocument, target.id, match.updatedNewString);
      workingPending[match.index] = { ...target, newString: match.updatedNewString };
      pendingPatched++;
    } else {
      log('chat', 'triage.unmatched', { oldPreview: edit.old_string.slice(0, 80) });
      remaining.push(edit);
    }
  }
  return { remainingEdits: remaining, pendingPatched };
}

export async function runTurn(ctx: TurnContext): Promise<ChatMessage> {
  const {
    model,
    agentPrompt,
    document,
    wikiIndex,
    docLabel,
    activeDocument,
    userText,
    displayText,
  } = ctx;

  const history = await loadHistory();
  log('chat', 'turn.start', {
    doc: activeDocument,
    model,
    docChars: document.length,
    historyLen: history.length,
    hasDisplayText: displayText !== undefined,
    isComment: userText.startsWith('COMMENT CONTEXT'),
  });

  const existingPending = await listPendingEditsSafe(activeDocument);
  log('chat', 'turn.pending.snapshot', {
    count: existingPending.length,
    ids: existingPending.map((e) => e.id).join(','),
  });

  const systemContent = buildSystemPrompt({
    agentPrompt,
    activeDocument,
    docLabel,
    document,
    pending: existingPending,
    wikiIndex,
  });

  const llmHistory: LlmMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
  // Replace the just-appended user turn with the full prompt for the LLM.
  if (displayText !== undefined && llmHistory.length > 0) {
    llmHistory[llmHistory.length - 1] = { role: 'user', content: userText };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: systemContent },
    ...llmHistory,
  ];

  log('chat', 'turn.systemPrompt', { chars: systemContent.length });

  let fullContent = await streamChat({
    model,
    messages,
    logScope: 'chat',
    onChunk: (chunk) => broadcast(IpcChannels.Chat.Chunk, chunk),
  });

  // Deep reference: if the LLM emitted source_lookup blocks, resolve them
  // deterministically from disk, inject the results, and re-stream. We cap
  // rounds so a buggy model can't loop us forever.
  for (let round = 0; round < MAX_LOOKUP_ROUNDS; round++) {
    const { requests } = parseSourceLookups(fullContent);
    if (requests.length === 0) break;
    log('chat', 'sourceLookup.round', { round, count: requests.length });
    const resolved = await resolveSourceLookups(requests);
    const followUp = formatLookupReply(resolved);
    const replayMessages: LlmMessage[] = [
      ...messages,
      { role: 'assistant', content: fullContent },
      { role: 'user', content: followUp },
    ];
    fullContent = await streamChat({
      model,
      messages: replayMessages,
      logScope: 'chat',
      onChunk: (chunk) => broadcast(IpcChannels.Chat.Chunk, chunk),
    });
  }

  // Strip any residual source_lookup fences before handing to edit parsing.
  fullContent = parseSourceLookups(fullContent).stripped || fullContent;

  let { edits, chatContent } = parseEditBlocks(fullContent);
  log('chat', 'turn.parsed', {
    edits: edits.length,
    editPreviews: edits.map((e) => ({
      oldLen: e.old_string.length,
      newLen: e.new_string.length,
      occ: e.occurrence ?? 1,
      oldPreview: e.old_string.slice(0, 80),
      newPreview: e.new_string.slice(0, 80),
    })),
    chatPreview: chatContent.slice(0, 200),
  });

  const triaged = await triageEditsAgainstPending(
    edits,
    existingPending,
    document,
    activeDocument,
  );
  edits = triaged.remainingEdits;
  const pendingPatched = triaged.pendingPatched;

  // Comment-context turns default to chat answers; don't nag the LLM to emit
  // an edit just because the scaffolded prompt has example change-verbs in it.
  const isCommentTurn = userText.startsWith('COMMENT CONTEXT');
  if (
    !isCommentTurn &&
    edits.length === 0 &&
    pendingPatched === 0 &&
    looksLikeDocumentRequest(userText, fullContent)
  ) {
    log('chat', 'retry.missingBlock', { userText: userText.slice(0, 120) });
    const doc = await readDocument(activeDocument);
    const retryMessages: LlmMessage[] = [
      ...messages,
      { role: 'assistant', content: fullContent },
      {
        role: 'user',
        content:
          `STOP. Your previous response did not contain a myst_edit code block, so nothing was applied to the document.\n\n` +
          `Your next response MUST begin with a fenced code block in exactly this format — no prose before it, no explanation, no apology:\n\n` +
          '```myst_edit\n' +
          `{\n  "old_string": "...",\n  "new_string": "..."\n}\n` +
          '```\n\n' +
          `Rules:\n` +
          `- To APPEND new content at the end of the document, set old_string to "" (empty string).\n` +
          `- To REPLACE existing text, copy the exact text from the document into old_string.\n` +
          `- To INSERT at a specific spot, set old_string to the text just before the insert point and new_string to that same text plus the new content.\n` +
          `- Do NOT mention myst_edit, old_string, or new_string in prose. Emit the block, then at most one short sentence of chat after.\n\n` +
          `Here is the current document:\n\n${doc}\n\n` +
          `Now emit the myst_edit block to fulfil the original request: "${userText.slice(0, 200)}"`,
      },
    ];
    const retryContent = await streamChat({
      model,
      messages: retryMessages,
      logScope: 'chat',
    });
    const retryResult = parseEditBlocks(retryContent);
    if (retryResult.edits.length > 0) {
      edits = retryResult.edits;
      if (!chatContent) chatContent = retryResult.chatContent;
    }
  }

  if (edits.length > 0) {
    const validation = validateEdits(document, edits);
    if (!validation.ok) {
      log('chat', 'retry.validation', { failures: validation.failures });
      const retryMessages: LlmMessage[] = [
        ...messages,
        { role: 'assistant', content: fullContent },
        {
          role: 'user',
          content:
            `Some edits could not be located in the document:\n${validation.failures.join('\n\n')}\n\n` +
            `Re-emit the failed myst_edit blocks. Keep old_string SHORT — one sentence ideally, never more than a few. Copy the exact snippet from the document character-for-character (quotes, dashes, whitespace). For ambiguous matches, add an "occurrence" field (1-indexed).`,
        },
      ];
      const retryContent = await streamChat({
        model,
        messages: retryMessages,
        logScope: 'chat',
      });
      const retryResult = parseEditBlocks(retryContent);
      let resolved = false;
      if (retryResult.edits.length > 0) {
        const retryValidation = validateEdits(document, retryResult.edits);
        if (retryValidation.ok) {
          edits = retryResult.edits;
          resolved = true;
        }
      }
      if (!resolved) {
        // Pre-flight failed twice. Drop the broken edits so we never stage
        // something that will blow up at accept time, and surface a chat note
        // so the user knows nothing landed and can re-phrase.
        log('chat', 'validation.dropped', {
          failures: validation.failures,
          retryEdits: retryResult.edits.length,
        });
        edits = [];
        if (!chatContent) {
          chatContent =
            "I couldn't locate the exact passage I wanted to change. Could you paste the snippet you'd like me to edit, or re-phrase the request?";
        }
      }
    }
  }

  const staged = await stageEdits(activeDocument, edits);
  const totalApplied = staged + pendingPatched;
  log('chat', 'turn.done', {
    staged,
    pendingPatched,
    totalApplied,
    finalChatPreview: chatContent.slice(0, 200),
  });

  let finalChat =
    totalApplied > 0 ? chatContent || 'Ready to review — check the pending edits.' : fullContent;
  finalChat = cleanChatContent(finalChat);

  const assistantMsg: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content:
      finalChat ||
      (totalApplied > 0
        ? `Staged ${totalApplied} edit${totalApplied === 1 ? '' : 's'} for review.`
        : ''),
    timestamp: new Date().toISOString(),
  };
  await appendMessage(assistantMsg);
  return assistantMsg;
}
