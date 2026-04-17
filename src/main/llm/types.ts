/** Shape of a single message sent to a chat completion. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Options accepted by streamChat(). Authentication (OpenRouter key vs
 * openmyst token) is resolved inside the facade, so callers never pass an
 * apiKey. In BYOK dev builds `model` is used as the OpenRouter model id; in
 * managed builds it is ignored (openmyst picks the model server-side).
 */
export interface StreamChatOptions {
  messages: LlmMessage[];
  /** OpenRouter model id; optional, BYOK-only. */
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
