import { app } from 'electron';
import { arch, platform } from 'node:os';
import { OPENMYST_API_BASE_URL } from '@shared/flags';
import { log, logError } from '../platform';
import { invalidateToken } from '../features/auth';
import { refreshAfterRequest } from '../features/me';
import type { LlmMessage, StreamChatResult } from './types';

/**
 * Managed-mode LLM client. Talks to `POST /api/v1/chat` on openmyst.ai using
 * the user's signed-in token (`omk_live_...`). Contract: see `changes.md`.
 *
 * The client intentionally mirrors openrouter.ts so feature code doesn't care
 * which backend is under the hood — same SSE parse loop, same "return the
 * full completion string" contract. Differences:
 *   - `Authorization` comes from the auth feature, not user settings.
 *   - `model` is forwarded in the body; the openmyst relay is expected to
 *     honor it (proxying through to the underlying provider). If omitted,
 *     the relay falls back to its server-side default.
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

/**
 * Wrap a fetch-producing thunk with 429 retry. The openmyst backend enforces
 * a sliding rate limit per user — when it fires, parallel panel + research
 * fetches cascade into the same cooldown window and the whole round fails
 * silently. This helper:
 *   - retries up to `maxAttempts` times on 429 (default 3, i.e. 2 retries)
 *   - respects the `Retry-After` header when present
 *   - falls back to parsing `"Try again in Xs"` out of the JSON body when
 *     the backend doesn't set a header (openmyst's current behaviour)
 *   - caps waits at 30s so we never pause the UI forever
 *   - consumes the response body when it's a retryable 429 (otherwise the
 *     connection stays half-open and we can't re-hit the same URL cleanly)
 *
 * Caller is responsible for processing the final `Response` — we only retry
 * the request, we do NOT read the body on success.
 */
export async function fetchWithRetryOn429(
  request: () => Promise<Response>,
  opts: { maxAttempts?: number; logScope?: string } = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const logScope = opts.logScope ?? 'llm';
  let lastBody = '';
  let lastStatus = 429;
  let lastHeaders: Headers | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await request();
    if (response.status !== 429) return response;
    // Read the body so we can re-issue the request on the same connection
    // cleanly AND extract the "Try again in Xs" hint from the JSON body.
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore body read failure; fall back to header hint */
    }
    lastBody = body;
    lastStatus = response.status;
    lastHeaders = response.headers;

    const headerHint = response.headers.get('Retry-After');
    let waitSec = headerHint ? Number.parseInt(headerHint, 10) : Number.NaN;
    if (Number.isNaN(waitSec)) {
      const match = body.match(/Try again in (\d+)\s*s/i);
      if (match) waitSec = Number.parseInt(match[1]!, 10);
    }
    if (Number.isNaN(waitSec) || waitSec <= 0) waitSec = 5;
    const waitMs = Math.min(waitSec * 1000, 30_000);

    if (attempt === maxAttempts) {
      // Give up — reconstitute a Response with the body we consumed so
      // callers' normal error-parsing code path works uniformly.
      return new Response(body, {
        status: lastStatus,
        headers: lastHeaders ?? undefined,
      });
    }

    log(logScope, 'openmyst.rateLimit.retry', {
      attempt,
      maxAttempts,
      waitSec,
      status: lastStatus,
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // Unreachable — the loop always either returns or exhausts maxAttempts.
  return new Response(lastBody, { status: lastStatus, headers: lastHeaders ?? undefined });
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
  model?: string;
  onChunk?: (chunk: string) => void;
  logScope?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<StreamChatResult> {
  const { token, messages, model, onChunk, logScope = 'llm' } = options;

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  log(logScope, 'openmyst.llm.request', {
    model: model ?? null,
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
  if (model) body['model'] = model;
  if (options.temperature !== undefined) body['temperature'] = options.temperature;
  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;

  const response = await fetchWithRetryOn429(
    () =>
      fetch(`${OPENMYST_API_BASE_URL}/api/v1/chat`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(body),
      }),
    { logScope },
  );

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
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null =
    null;

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
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (chunk) {
          fullContent += chunk;
          onChunk?.(chunk);
        }
        // The final SSE frame before `[DONE]` carries token counts per the
        // OpenAI-compatible streaming contract. Keep the latest one we see.
        if (parsed.usage) usage = parsed.usage;
      } catch {
        // Keepalives / malformed lines — ignore.
      }
    }
  }

  log(logScope, 'openmyst.llm.response', {
    chars: fullContent.length,
    elapsedMs: Date.now() - t0,
    sawDone,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    preview: fullContent.slice(0, 400),
  });

  // Per contract §5, a dropped stream ends without `[DONE]`. We return
  // the partial content + `complete: false` so callers (the drafter
  // especially) can surface a "cut off" marker and save what got
  // generated rather than losing 5 minutes of tokens to a proxy timeout.
  if (!sawDone && fullContent.length > 0) {
    log(logScope, 'openmyst.llm.streamIncomplete', { chars: fullContent.length });
  }
  refreshAfterRequest();
  return { content: fullContent, complete: sawDone };
}

/**
 * Non-streaming completion (`stream: false`). Returns the raw content string.
 * Mirrors `openrouterCompleteText` — caller is responsible for JSON parsing
 * when the prompt asks for a JSON answer.
 */
export async function openmystCompleteText(options: {
  token: string;
  messages: LlmMessage[];
  model?: string;
  logScope?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string | null> {
  const { token, messages, model, logScope = 'llm' } = options;

  const body: Record<string, unknown> = { messages, stream: false };
  if (model) body['model'] = model;
  if (options.temperature !== undefined) body['temperature'] = options.temperature;
  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;

  try {
    const response = await fetchWithRetryOn429(
      () =>
        fetch(`${OPENMYST_API_BASE_URL}/api/v1/chat`, {
          method: 'POST',
          headers: buildHeaders(token),
          body: JSON.stringify(body),
        }),
      { logScope },
    );

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
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    refreshAfterRequest();
    return content;
  } catch (err) {
    logError(logScope, 'openmyst.llm.request.failed', err);
    return null;
  }
}
