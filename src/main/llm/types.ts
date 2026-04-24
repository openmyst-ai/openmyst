/** Shape of a single message sent to a chat completion. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Options accepted by streamChat(). Authentication (OpenRouter key vs
 * openmyst token) is resolved inside the facade, so callers never pass an
 * apiKey. `model` is forwarded in both BYOK (to OpenRouter directly) and
 * managed (to the openmyst.ai relay, which proxies it onward). If omitted,
 * the facade falls back to the user's saved default.
 */
export interface StreamChatOptions {
  messages: LlmMessage[];
  /** Model id (e.g. `deepseek/deepseek-v3.2`). */
  model?: string;
  /** Called with each content chunk as it arrives from the stream. */
  onChunk?: (chunk: string) => void;
  /** Scope label for the logger — e.g. 'chat', 'sources'. Defaults to 'llm'. */
  logScope?: string;
}

/**
 * Structured result from a streaming completion. `content` is the full
 * concatenated body of the assistant reply. `complete` is `true` only
 * when the server's SSE stream reached its natural `[DONE]` terminator —
 * `false` when the connection dropped mid-stream (usually a proxy or
 * hosting-platform timeout around 300s). Callers that care about
 * completeness (the one-shot drafter especially) use it to surface a
 * "draft was cut off" banner instead of silently shipping a truncated
 * artefact.
 */
export interface StreamChatResult {
  content: string;
  complete: boolean;
}

export interface CompleteTextOptions {
  messages: LlmMessage[];
  model?: string;
  logScope?: string;
  /**
   * Upper bound on response tokens. Forwarded as `max_tokens` to the
   * backend. Omit to use the provider's default (usually 4096). Bump when
   * the caller needs a genuinely long structured response — Deep Plan's
   * Chair, for example, emits vision rewrites that can run ~2k output
   * tokens and need headroom.
   */
  maxTokens?: number;
}
