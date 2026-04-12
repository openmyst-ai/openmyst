import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { ChatMessage } from '@shared/types';
import { getCurrentProject } from './projects';
import { getOpenRouterKey } from './settings';
import { getSettings } from './settings';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function projectPath(file: string): string {
  const project = getCurrentProject();
  if (!project) throw new Error('No project is open.');
  return join(project.path, file);
}

async function readProjectFile(file: string): Promise<string> {
  try {
    return await fs.readFile(projectPath(file), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function appendMessage(msg: ChatMessage): Promise<void> {
  const path = projectPath('chat.jsonl');
  await fs.appendFile(path, JSON.stringify(msg) + '\n', 'utf-8');
}

export async function loadHistory(): Promise<ChatMessage[]> {
  const raw = await readProjectFile('chat.jsonl');
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChatMessage);
}

export async function clearHistory(): Promise<void> {
  await fs.writeFile(projectPath('chat.jsonl'), '', 'utf-8');
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

async function streamCompletion(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  emitChunks: boolean,
): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://myst-review.app',
      'X-Title': 'Myst Review',
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${body}`);
  }

  let fullContent = '';
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream available.');

  const decoder = new TextDecoder();
  let buffer = '';

  let reading = true;
  while (reading) {
    const { done, value } = await reader.read();
    if (done) {
      reading = false;
      continue;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (chunk) {
          fullContent += chunk;
          if (emitChunks) sendToRenderer(IpcChannels.Chat.Chunk, chunk);
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  return fullContent;
}

interface EditOp {
  old_string: string;
  new_string: string;
}

interface ApplyResult {
  ok: boolean;
  error?: string;
  index: number;
}

function extractEdits(text: string): { edits: EditOp[]; chatContent: string } {
  const regex = /```myst_edit\s*\n([\s\S]*?)```/g;
  const edits: EditOp[] = [];
  let chatContent = text;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const raw = match[1].trim();
      const parsed = JSON.parse(raw) as { old_string?: string; new_string?: string };
      if (typeof parsed.old_string === 'string' && typeof parsed.new_string === 'string') {
        edits.push({
          old_string: parsed.old_string,
          new_string: parsed.new_string,
        });
      }
    } catch {
      console.log('[myst-chat] failed to parse myst_edit JSON:', match[1]);
    }
    chatContent = chatContent.replace(match[0], '');
  }

  chatContent = chatContent.replace(/\n{3,}/g, '\n\n').trim();
  return { edits, chatContent };
}

function applyEdit(doc: string, edit: EditOp): ApplyResult & { doc: string } {
  if (edit.old_string === '') {
    const trimmed = doc.trimEnd();
    return { ok: true, index: 0, doc: trimmed + '\n\n' + edit.new_string + '\n' };
  }

  const first = doc.indexOf(edit.old_string);
  if (first === -1) {
    return { ok: false, error: 'old_string not found in document', index: 0, doc };
  }

  const second = doc.indexOf(edit.old_string, first + 1);
  if (second !== -1) {
    return { ok: false, error: 'old_string matches multiple locations — make it more specific', index: 0, doc };
  }

  const newDoc = doc.slice(0, first) + edit.new_string + doc.slice(first + edit.old_string.length);
  return { ok: true, index: first, doc: newDoc };
}

const CHANGE_WORDS = /\b(changed|updated|switched|swapped|renamed|replaced|tweaked|edited|modified|added|wrote|dropped|inserted|promotion|start|here'?s)\b/i;
const REQUEST_WORDS = /\b(write|create|add|change|rename|edit|fix|rewrite|make|extend|continue|update|swap|replace|remove|delete)\b/i;

function looksLikeDocumentRequest(userText: string, llmResponse: string): boolean {
  return REQUEST_WORDS.test(userText) || CHANGE_WORDS.test(llmResponse);
}

function cleanChatContent(text: string): string {
  return text
    .replace(/```myst_edit\s*\n[\s\S]*?```/g, '')
    .replace(/`myst_edit`/gi, '')
    .replace(/myst_edit/gi, '')
    .replace(/old_string/g, '')
    .replace(/new_string/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function sendMessage(userText: string): Promise<ChatMessage> {
  const apiKey = await getOpenRouterKey();
  if (!apiKey) throw new Error('OpenRouter API key not set. Add it in Settings.');

  const settings = await getSettings();
  const model = settings.defaultModel;

  const agentPrompt = await readProjectFile('agent.md');
  const document = await readProjectFile('document.md');
  const sourcesIndex = await readProjectFile('sources/index.md');

  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: userText,
    timestamp: new Date().toISOString(),
  };
  await appendMessage(userMsg);

  const history = await loadHistory();

  const systemContent = [
    agentPrompt,
    '\n\n========== BEGIN document.md ==========\n' + document + '\n========== END document.md ==========',
    sourcesIndex.trim()
      ? '\n\n========== BEGIN sources/index.md (READ-ONLY, not part of the document) ==========\n' + sourcesIndex + '\n========== END sources/index.md =========='
      : '',
  ].join('');

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemContent },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const fullContent = await streamCompletion(apiKey, model, messages, true);
  sendToRenderer(IpcChannels.Chat.ChunkDone);

  console.log('[myst-chat] full LLM response:\n', fullContent);

  let { edits, chatContent } = extractEdits(fullContent);
  console.log('[myst-chat] extracted edits:', edits.length);

  if (edits.length === 0 && looksLikeDocumentRequest(userText, fullContent)) {
    console.log('[myst-chat] no edits found but looks like a document change — retrying');
    const doc = await readProjectFile('document.md');
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: fullContent },
      {
        role: 'user',
        content: `You forgot to include the myst_edit block. Here is the current document:\n\n${doc}\n\nPlease output the myst_edit block(s) now to make the change.`,
      },
    ];
    const retryContent = await streamCompletion(apiKey, model, retryMessages, false);
    console.log('[myst-chat] retry response:\n', retryContent);
    const retryResult = extractEdits(retryContent);
    if (retryResult.edits.length > 0) {
      edits = retryResult.edits;
      if (!chatContent) chatContent = retryResult.chatContent;
    }
  }

  let madeChanges = false;

  if (edits.length > 0) {
    let doc = await readProjectFile('document.md');
    console.log('[myst-chat] document before:', JSON.stringify(doc.slice(0, 300)));

    const failures: string[] = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      console.log('[myst-chat] applying edit', i, 'old:', JSON.stringify(edit.old_string.slice(0, 100)));
      const result = applyEdit(doc, edit);
      if (result.ok) {
        doc = result.doc;
        madeChanges = true;
        console.log('[myst-chat] edit', i, 'applied successfully');
      } else {
        console.log('[myst-chat] edit', i, 'FAILED:', result.error);
        failures.push(`Edit ${i}: ${result.error} (old_string: "${edit.old_string.slice(0, 60)}...")`);
      }
    }

    if (failures.length > 0) {
      console.log('[myst-chat] retrying failed edits...');
      const freshDoc = madeChanges ? doc : await readProjectFile('document.md');
      const retryMessages = [
        ...messages,
        { role: 'assistant', content: fullContent },
        {
          role: 'user',
          content: `Some edits failed:\n${failures.join('\n')}\n\nHere is the current document:\n\n${freshDoc}\n\nPlease retry the failed edits with corrected old_string values that match exactly once.`,
        },
      ];
      const retryContent = await streamCompletion(apiKey, model, retryMessages, false);
      console.log('[myst-chat] retry response:\n', retryContent);
      const retryResult = extractEdits(retryContent);
      for (let i = 0; i < retryResult.edits.length; i++) {
        const result = applyEdit(doc, retryResult.edits[i]);
        if (result.ok) {
          doc = result.doc;
          madeChanges = true;
          console.log('[myst-chat] retry edit', i, 'applied successfully');
        } else {
          console.log('[myst-chat] retry edit', i, 'FAILED again:', result.error);
        }
      }
    }

    if (madeChanges) {
      console.log('[myst-chat] document after:', JSON.stringify(doc.slice(0, 300)));
      await fs.writeFile(projectPath('document.md'), doc, 'utf-8');
      sendToRenderer(IpcChannels.Document.Changed);
    }
  }

  let finalChat = madeChanges ? (chatContent || 'Document updated.') : fullContent;
  finalChat = cleanChatContent(finalChat);

  const assistantMsg: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: finalChat || 'Document updated.',
    timestamp: new Date().toISOString(),
  };
  await appendMessage(assistantMsg);

  return assistantMsg;
}
