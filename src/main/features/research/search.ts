import { USE_OPENMYST, OPENMYST_API_BASE_URL } from '@shared/flags';
import { app } from 'electron';
import { arch, platform } from 'node:os';
import { log, logError } from '../../platform';
import { getAuthTokenSync, invalidateToken } from '../auth';
import { refreshAfterRequest } from '../me';
import { getJinaKey } from '../settings';
import { jinaSearch, type JinaResult } from '../deepPlan/jina';

/**
 * Web-search facade. Features in the research stack call `searchWeb` without
 * caring which provider is serving results: in BYOK dev mode the app hits
 * Jina directly with a user key; in managed mode the app hits
 * `openmyst.ai/api/v1/search` with the signed-in token and the backend
 * proxies to Jina on our behalf.
 *
 * Return shape is the BYOK (`JinaResult`) shape because every downstream
 * consumer — the research engine's too-short/bot-block filters, the source
 * ingester — already understands it. Managed-mode results map as best they
 * can: `snippet` → `content`, absent page body → `rawContent: null`.
 */

export type { JinaResult } from '../deepPlan/jina';

export async function ensureSearchReady(): Promise<void> {
  if (USE_OPENMYST) {
    if (!getAuthTokenSync()) throw new Error('Sign in to run research.');
    return;
  }
  const jinaKey = await getJinaKey();
  if (!jinaKey) {
    throw new Error('Jina API key not set. Open Settings and add one.');
  }
}

export async function searchWeb(options: {
  query: string;
  maxResults?: number;
  logScope?: string;
}): Promise<JinaResult[]> {
  if (USE_OPENMYST) {
    return openmystSearch(options);
  }
  const jinaKey = await getJinaKey();
  if (!jinaKey) return [];
  const resp = await jinaSearch({ apiKey: jinaKey, query: options.query, maxResults: options.maxResults });
  return resp?.results ?? [];
}

interface OpenmystSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  /** Some backend deployments pass Jina's full scrape through; treat as optional. */
  content?: string;
  rawContent?: string;
}

interface OpenmystSearchResponse {
  query?: string;
  results?: OpenmystSearchResult[];
}

async function openmystSearch(options: {
  query: string;
  maxResults?: number;
  logScope?: string;
}): Promise<JinaResult[]> {
  const token = getAuthTokenSync();
  if (!token) {
    log(options.logScope ?? 'search', 'openmyst.noToken', {});
    return [];
  }
  const version = app.getVersion();
  const body: Record<string, unknown> = { query: options.query };
  if (options.maxResults !== undefined) body['num_results'] = options.maxResults;

  try {
    const response = await fetch(`${OPENMYST_API_BASE_URL}/api/v1/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': `openmyst-desktop/${version} (${platform()}-${arch()})`,
        'X-Client-Version': version,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let code = '';
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string } };
        code = parsed.error?.code ?? '';
      } catch {
        /* non-JSON body */
      }
      if (response.status === 401 && (code === 'invalid_token' || code === 'token_revoked')) {
        void invalidateToken(code);
      }
      logError(options.logScope ?? 'search', 'openmyst.http.failed', new Error(text), {
        status: response.status,
        code,
      });
      return [];
    }

    const data = (await response.json()) as OpenmystSearchResponse;
    const entries = Array.isArray(data.results) ? data.results : [];
    refreshAfterRequest();
    return entries.map((r) => {
      const snippet = typeof r.snippet === 'string' ? r.snippet : '';
      const content = typeof r.content === 'string' ? r.content : '';
      const full = typeof r.rawContent === 'string' ? r.rawContent : null;
      return {
        title: typeof r.title === 'string' && r.title.length > 0 ? r.title : 'Untitled',
        url: typeof r.url === 'string' ? r.url : '',
        content: snippet || content.slice(0, 400),
        rawContent: full ?? (content.length > 0 ? content : null),
        score: 0,
      };
    });
  } catch (err) {
    logError(options.logScope ?? 'search', 'openmyst.request.failed', err, { query: options.query });
    return [];
  }
}
