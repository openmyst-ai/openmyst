import { log, logError } from '../platform';
import type { LlmMessage, StreamChatOptions, StreamChatResult } from './types';

/**
 * Single source of truth for talking to OpenRouter. Every feature that calls
 * an LLM (chat, sources/digest, future extractors…) goes through here.
 *
 * Why this exists: before the refactor, chat.ts and sources.ts each had their
 * own `fetch(OPENROUTER_URL, …)` block with slightly different headers, no
 * shared retry, no shared streaming parser. Changing the model default, the
 * referer, or the transport meant editing every feature file. Now it's one
 * file.
 *
 * Design notes:
 *   - Transport is `fetch`. No SDK, no third-party client. OpenRouter speaks
 *     OpenAI-compatible JSON and that is plenty.
 *   - Streaming is line-parsed from the SSE response body.
 *   - Errors throw with the response body inlined so the UI can surface them.
 *   - `onChunk` is optional. For non-streaming callers (e.g. the sources
 *     digest), pass only messages + apiKey + model and take the returned string.
 */

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_HEADERS = {
  'HTTP-Referer': 'https://github.com/openmyst-ai/openmyst',
  'X-Title': 'Open Myst',
} as const;

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...DEFAULT_HEADERS,
  };
}

/**
 * Stream a chat completion from OpenRouter and return the full concatenated
 * content when the stream closes. Invokes `onChunk` for each delta as it
 * arrives so the renderer can show tokens live.
 */
/**
 * Low-level OpenRouter streaming client. Feature code should call the
 * `streamChat` facade in `llm/index.ts` instead — it branches between this
 * and the openmyst client based on the build-time flag.
 */
export async function openrouterStreamChat(options: {
  apiKey: string;
  model: string;
  messages: StreamChatOptions['messages'];
  onChunk?: StreamChatOptions['onChunk'];
  logScope?: StreamChatOptions['logScope'];
}): Promise<StreamChatResult> {
  const { apiKey, model, messages, onChunk, logScope = 'llm' } = options;

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  log(logScope, 'llm.request', {
    model,
    messages: messages.length,
    roles: messages.map((m) => m.role).join(','),
    totalChars,
    streaming: true,
  });

  const t0 = Date.now();
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok) {
    const body = await response.text();
    logError(logScope, 'llm.http.failed', new Error(body), { status: response.status });
    throw new Error(`OpenRouter error ${response.status}: ${body}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream available.');

  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let reading = true;
  let sawDone = false;

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
      if (data === '[DONE]') {
        sawDone = true;
        continue;
      }

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (chunk) {
          fullContent += chunk;
          onChunk?.(chunk);
        }
      } catch {
        // skip malformed chunks — OpenRouter occasionally sends keepalives
      }
    }
  }

  log(logScope, 'llm.response', {
    chars: fullContent.length,
    elapsedMs: Date.now() - t0,
    sawDone,
    preview: fullContent.slice(0, 400),
  });
  if (!sawDone && fullContent.length > 0) {
    log(logScope, 'llm.streamIncomplete', { chars: fullContent.length });
  }
  return { content: fullContent, complete: sawDone };
}

/**
 * Non-streaming completion that expects the LLM to return a JSON object.
 * Used by the sources digest path, which doesn't need token-by-token output.
 *
 * Returns the raw content string — parsing is the caller's job, since each
 * caller has its own expected shape and fallback behaviour on bad JSON.
 */
export async function openrouterCompleteText(options: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  logScope?: string;
  maxTokens?: number;
}): Promise<string | null> {
  const { apiKey, model, messages, logScope = 'llm', maxTokens } = options;

  try {
    const body: Record<string, unknown> = { model, messages, stream: false };
    if (maxTokens !== undefined) body['max_tokens'] = maxTokens;
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      logError(logScope, 'llm.http.failed', new Error(await response.text()), {
        status: response.status,
      });
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    logError(logScope, 'llm.request.failed', err);
    return null;
  }
}
