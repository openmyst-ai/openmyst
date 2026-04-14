import { log, logError } from '../../platform';

/**
 * Minimal Tavily client. User supplies their own API key in settings.
 * We use the /search endpoint with `include_raw_content` so the research
 * loop can ingest fetched pages as sources without a separate fetch step.
 */

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  rawContent: string | null;
  score: number;
}

export interface TavilySearchResponse {
  query: string;
  answer: string | null;
  results: TavilyResult[];
}

export async function tavilySearch(options: {
  apiKey: string;
  query: string;
  maxResults?: number;
  searchDepth?: 'basic' | 'advanced';
}): Promise<TavilySearchResponse | null> {
  const { apiKey, query, maxResults = 5, searchDepth = 'advanced' } = options;

  const body = {
    api_key: apiKey,
    query,
    search_depth: searchDepth,
    include_answer: true,
    include_raw_content: true,
    max_results: maxResults,
  };

  log('deep-plan', 'tavily.request', { query, maxResults, searchDepth });

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      logError('deep-plan', 'tavily.http.failed', new Error(text), { status: response.status });
      return null;
    }

    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        raw_content?: string | null;
        score?: number;
      }>;
    };

    const results: TavilyResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? 'Untitled',
      url: r.url ?? '',
      content: r.content ?? '',
      rawContent: r.raw_content ?? null,
      score: r.score ?? 0,
    }));

    log('deep-plan', 'tavily.response', { query, resultCount: results.length });

    return {
      query,
      answer: data.answer ?? null,
      results,
    };
  } catch (err) {
    logError('deep-plan', 'tavily.request.failed', err, { query });
    return null;
  }
}
