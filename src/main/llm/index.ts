import { USE_OPENMYST } from '@shared/flags';
import { getAuthTokenSync } from '../features/auth';
import { getOpenRouterKey, getSettings } from '../features/settings';
import { openrouterCompleteText, openrouterStreamChat } from './openrouter';
import { openmystCompleteText, openmystStreamChat } from './openmyst';
import type { CompleteTextOptions, StreamChatOptions } from './types';

/**
 * LLM facade. Every feature that needs a completion imports from here, not
 * from the concrete provider modules. This is where the build-time flag
 * picks between OpenRouter (BYOK dev mode) and openmyst.ai (managed mode).
 *
 * The split matters for the managed build: we do NOT want OpenRouter URLs,
 * OpenRouter key prompts, or any BYOK branch shipping in the end-user binary.
 * Vite's `define` replaces `USE_OPENMYST` with a literal at build time so
 * Rollup can tree-shake the unused path.
 *
 * Public surface:
 *   - streamChat({messages, model?, onChunk?, logScope?}) → full completion
 *   - completeText({messages, model?, logScope?})        → non-streaming string
 *   - ensureLlmReady()                                   → pre-flight auth check
 *   - LlmMessage, StreamChatOptions, OpenmystApiError    → types
 */

export * from './types';
export { OpenmystApiError } from './openmyst';

/**
 * Throw a user-friendly error up front if the LLM backend cannot be called
 * — avoids kicking off half a turn (user message persisted, "chat started"
 * broadcast) before realising we have no credentials.
 */
export async function ensureLlmReady(): Promise<void> {
  if (USE_OPENMYST) {
    if (!getAuthTokenSync()) {
      throw new Error('Sign in to use Open Myst.');
    }
    return;
  }
  const key = await getOpenRouterKey();
  if (!key) throw new Error('OpenRouter API key not set. Add it in Settings.');
}

export async function streamChat(options: StreamChatOptions): Promise<string> {
  if (USE_OPENMYST) {
    const token = getAuthTokenSync();
    if (!token) throw new Error('Sign in to use Open Myst.');
    const managedOpts: Parameters<typeof openmystStreamChat>[0] = {
      token,
      messages: options.messages,
    };
    if (options.onChunk) managedOpts.onChunk = options.onChunk;
    if (options.logScope) managedOpts.logScope = options.logScope;
    return openmystStreamChat(managedOpts);
  }

  const apiKey = await getOpenRouterKey();
  if (!apiKey) throw new Error('OpenRouter API key not set. Add it in Settings.');
  const model = options.model ?? (await getSettings()).defaultModel;
  const byokOpts: Parameters<typeof openrouterStreamChat>[0] = {
    apiKey,
    model,
    messages: options.messages,
  };
  if (options.onChunk) byokOpts.onChunk = options.onChunk;
  if (options.logScope) byokOpts.logScope = options.logScope;
  return openrouterStreamChat(byokOpts);
}

export async function completeText(options: CompleteTextOptions): Promise<string | null> {
  if (USE_OPENMYST) {
    const token = getAuthTokenSync();
    if (!token) return null;
    const managedOpts: Parameters<typeof openmystCompleteText>[0] = {
      token,
      messages: options.messages,
    };
    if (options.logScope) managedOpts.logScope = options.logScope;
    return openmystCompleteText(managedOpts);
  }

  const apiKey = await getOpenRouterKey();
  if (!apiKey) return null;
  const model = options.model ?? (await getSettings()).defaultModel;
  const byokOpts: Parameters<typeof openrouterCompleteText>[0] = {
    apiKey,
    model,
    messages: options.messages,
  };
  if (options.logScope) byokOpts.logScope = options.logScope;
  return openrouterCompleteText(byokOpts);
}
