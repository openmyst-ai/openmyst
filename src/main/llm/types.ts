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

export interface CompleteTextOptions {
  messages: LlmMessage[];
  model?: string;
  logScope?: string;
}
