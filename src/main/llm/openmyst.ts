import { app } from 'electron';
import { arch, platform } from 'node:os';
import { OPENMYST_API_BASE_URL } from '@shared/flags';
import { log, logError } from '../platform';
import { invalidateToken } from '../features/auth';
import type { LlmMessage } from './types';

/**
 * Managed-mode LLM client. Talks to `POST /api/v1/chat` on openmyst.ai using
 * the user's signed-in token (`omk_live_...`). Contract: see `changes.md`.
 *
 * The client intentionally mirrors openrouter.ts so feature code doesn't care
 * which backend is under the hood — same SSE parse loop, same "return the
 * full completion string" contract. Differences:
 *   - `Authorization` comes from the auth feature, not user settings.
 *   - No `model` field in the body; openmyst picks the model server-side.
 *   - Error bodies follow the openmyst error envelope (see §5).
 *   - 401 invalid_token / token_revoked ⇒ we clear the token immediately
 *     so the renderer's auth listener pushes the user to the login screen.
 */

/**
 * Typed error thrown for any non-2xx response from openmyst.ai. Features
 * catch these and map to user-facing messages (quota modal, cooldown toast,
 * etc.) per the table in `changes.md` §5.
 */
export class OpenmystApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly upgradeUrl?: string;
  readonly retryAfter?: number;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    upgradeUrl?: string;
    retryAfter?: number;
  }) {
    super(opts.message);
    this.name = 'OpenmystApiError';
    this.status = opts.status;
    this.code = opts.code;
    if (opts.upgradeUrl) this.upgradeUrl = opts.upgradeUrl;
    if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
  }
}

interface OpenmystErrorBody {
  error?: {
    code?: string;
    message?: string;
    upgrade_url?: string;
  };
}

/**
 * Build the default header set. `User-Agent` + `X-Client-Version` are
 * required by the contract (§3.1) so the backend can correlate errors to
 * specific app versions.
 */
function buildHeaders(token: string): Record<string, string> {
  const version = app.getVersion();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': `openmyst-desktop/${version} (${platform()}-${arch()})`,
    'X-Client-Version': version,
  };
}

async function parseErrorResponse(response: Response): Promise<OpenmystApiError> {
  let body: OpenmystErrorBody = {};
  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
  try {
    body = (await response.json()) as OpenmystErrorBody;
  } catch {
    // Non-JSON body — fall through with a generic code.
  }
  const code = body.error?.code ?? 'unknown_error';
  const message = body.error?.message ?? `openmyst returned ${response.status}`;

  // 401s cost us the token — drop it now so the UI flips to the login screen.
  // This is fire-and-forget; the renderer gets notified via the Auth.Changed
  // broadcast from signOut().
  if (response.status === 401 && (code === 'invalid_token' || code === 'token_revoked')) {
    void invalidateToken(code);
  }

  const errOpts: {
    status: number;
    code: string;
    message: string;
    upgradeUrl?: string;
    retryAfter?: number;
  } = { status: response.status, code, message };
  if (body.error?.upgrade_url) errOpts.upgradeUrl = body.error.upgrade_url;
  if (retryAfter !== undefined && !Number.isNaN(retryAfter)) errOpts.retryAfter = retryAfter;

  return new OpenmystApiError(errOpts);
}

/**
 * Stream a chat completion from openmyst.ai. Same streaming contract as
 * `openrouterStreamChat`: feeds `onChunk` with each content delta, returns
 * the full concatenated content once the stream closes.
 */
export async function openmystStreamChat(options: {
  token: string;
  messages: LlmMessage[];
  onChunk?: (chunk: string) => void;
  logScope?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const { token, messages, onChunk, logScope = 'llm' } = options;

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  log(logScope, 'openmyst.llm.request', {
    messages: messages.length,
    roles: messages.map((m) => m.role).join(','),
    totalChars,
    streaming: true,
  });

  const t0 = Date.now();
  const body: Record<string, unknown> = {
    messages,
    stream: true,
  };
  if (options.temperature !== undefined) body['temperature'] = options.temperature;
  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;

  const response = await fetch(`${OPENMYST_API_BASE_URL}/api/v1/chat`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await parseErrorResponse(response);
    logError(logScope, 'openmyst.llm.http.failed', err, { status: response.status, code: err.code });
    throw err;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream available.');

  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let sawDone = false;
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
        // Keepalives / malformed lines — ignore.
      }
    }
  }

  log(logScope, 'openmyst.llm.response', {
    chars: fullContent.length,
    elapsedMs: Date.now() - t0,
    sawDone,
    preview: fullContent.slice(0, 400),
  });

  // Per contract §5, a dropped stream ends without `[DONE]`. Let the caller
  // decide whether to display whatever arrived with an "interrupted" marker.
  if (!sawDone && fullContent.length > 0) {
    log(logScope, 'openmyst.llm.streamIncomplete', { chars: fullContent.length });
  }
  return fullContent;
}

/**
 * Non-streaming completion (`stream: false`). Returns the raw content string.
 * Mirrors `openrouterCompleteText` — caller is responsible for JSON parsing
 * when the prompt asks for a JSON answer.
 */
export async function openmystCompleteText(options: {
  token: string;
  messages: LlmMessage[];
  logScope?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string | null> {
  const { token, messages, logScope = 'llm' } = options;

  const body: Record<string, unknown> = { messages, stream: false };
  if (options.temperature !== undefined) body['temperature'] = options.temperature;
  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;

  try {
    const response = await fetch(`${OPENMYST_API_BASE_URL}/api/v1/chat`, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await parseErrorResponse(response);
      logError(logScope, 'openmyst.llm.http.failed', err, {
        status: response.status,
        code: err.code,
      });
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    logError(logScope, 'openmyst.llm.request.failed', err);
    return null;
  }
}
