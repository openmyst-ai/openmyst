import { log, logError } from '../../platform';
import { searchWeb, ensureSearchReady, type JinaResult } from './search';

/**
 * LLM-facing `web_search` protocol for the regular chat turn.
 *
 * Shape:
 *   ```web_search
 *   {"query": "policy gradient nearest-neighbor reward shaping"}
 *   ```
 *
 * The agent emits one or more of these fences when the user's ask needs
 * external knowledge — "is this novel?", "find prior work", "what's the
 * state of the art on X?" — and the turn loop resolves each against the
 * same search backend Deep Search uses (openmyst.ai relay, or Jina BYOK in
 * dev). Results are injected back as a follow-up user message so the model
 * can quote them on its next stream.
 *
 * Intentionally kept parallel to `source_lookup`: both are cheap, both
 * replay in the same orchestration loop, and parsing is I/O-free so it's
 * testable.
 */

const WEB_SEARCH_FENCE = /```web_search\s*\n([\s\S]*?)```/g;

const MAX_RESULTS_PER_QUERY = 5;
const MAX_SNIPPET_CHARS = 500;

export interface WebSearchRequest {
  query: string;
}

export interface WebSearchParseResult {
  requests: WebSearchRequest[];
  stripped: string;
}

export function parseWebSearches(text: string): WebSearchParseResult {
  const requests: WebSearchRequest[] = [];
  let stripped = text;
  let match: RegExpExecArray | null;
  WEB_SEARCH_FENCE.lastIndex = 0;
  while ((match = WEB_SEARCH_FENCE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!.trim()) as { query?: unknown };
      if (typeof parsed.query === 'string' && parsed.query.trim().length > 0) {
        requests.push({ query: parsed.query.trim() });
      }
    } catch {
      // malformed block — drop silently
    }
    stripped = stripped.replace(match[0], '');
  }
  return { requests, stripped: stripped.trim() };
}

export interface ResolvedWebSearch {
  request: WebSearchRequest;
  results: JinaResult[];
  error: string | null;
}

export async function resolveWebSearches(
  requests: WebSearchRequest[],
): Promise<ResolvedWebSearch[]> {
  if (requests.length === 0) return [];
  try {
    await ensureSearchReady();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('chat', 'webSearch.notReady', { error: msg });
    return requests.map((request) => ({ request, results: [], error: msg }));
  }
  const out: ResolvedWebSearch[] = [];
  for (const req of requests) {
    try {
      const results = await searchWeb({
        query: req.query,
        maxResults: MAX_RESULTS_PER_QUERY,
        logScope: 'chat',
      });
      log('chat', 'webSearch.hit', { query: req.query, count: results.length });
      out.push({ request: req, results, error: null });
    } catch (err) {
      logError('chat', 'webSearch.failed', err, { query: req.query });
      const msg = err instanceof Error ? err.message : String(err);
      out.push({ request: req, results: [], error: msg });
    }
  }
  return out;
}

export function formatWebSearchReply(resolved: ResolvedWebSearch[]): string {
  if (resolved.length === 0) return '';
  const parts = resolved.map(({ request, results, error }) => {
    if (error) {
      return `**Web search failed:** \`${request.query}\` — ${error}`;
    }
    if (results.length === 0) {
      return `**Web search (0 results):** \`${request.query}\``;
    }
    const items = results
      .map((r, i) => {
        const snippet = (r.content ?? '').slice(0, MAX_SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
        const title = r.title || 'Untitled';
        const url = r.url || '';
        return `${i + 1}. **${title}**\n   ${url}\n   ${snippet}`;
      })
      .join('\n\n');
    return `**Web search:** \`${request.query}\`\n\n${items}`;
  });
  return (
    '[web_search results — live results from the web. Quote URLs when citing them, and do NOT invent sources.]\n\n' +
    parts.join('\n\n---\n\n')
  );
}
