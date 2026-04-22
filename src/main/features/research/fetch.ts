import { USE_OPENMYST, OPENMYST_API_BASE_URL } from '@shared/flags';
import { app } from 'electron';
import { arch, platform } from 'node:os';
import { log, logError } from '../../platform';
import { getAuthTokenSync, invalidateToken } from '../auth';
import { refreshAfterRequest } from '../me';
import { getJinaKey } from '../settings';
import { checkSourceAllowed } from './credibility';

/**
 * Single-URL fetch → markdown. Same provider split as `searchWeb`: BYOK hits
 * Jina Reader directly (`r.jina.ai/<url>`), managed goes through an openmyst
 * relay endpoint.
 *
 * Why Jina Reader: cheapest good-enough web-to-markdown on the market
 * (pennies per page), handles JS-rendered pages, and we already have the key
 * pipe for it. Users asked for "add a URL as a source" — this is the quickest
 * way to give them that without shipping a headless browser.
 */

const JINA_READER_BASE = 'https://r.jina.ai/';

export interface FetchedPage {
  /** Title pulled out of the response, falling back to the URL host. */
  title: string;
  /** Markdown body. Never null — worst case it's empty and the caller bails. */
  markdown: string;
  /** The URL we actually resolved to (may differ from input after redirects). */
  url: string;
}

export async function fetchUrlAsMarkdown(url: string): Promise<FetchedPage> {
  const trimmed = url.trim();
  const verdict = checkSourceAllowed(trimmed);
  if (!verdict.allowed) {
    log('sources', 'fetchUrl.blocked', { host: verdict.host ?? null });
    throw new Error(verdict.reason ?? 'Source is not permitted.');
  }
  if (USE_OPENMYST) return openmystFetch(trimmed);
  return jinaReaderFetch(trimmed);
}

async function jinaReaderFetch(url: string): Promise<FetchedPage> {
  const apiKey = await getJinaKey();
  // r.jina.ai works without a key (shared rate limits), but a key unlocks
  // higher throughput and less bot friction. Use one if we have it.
  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  log('sources', 'fetchUrl.byok.request', { url, keyed: apiKey !== null });
  const response = await fetch(`${JINA_READER_BASE}${url}`, { method: 'GET', headers });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logError('sources', 'fetchUrl.byok.http.failed', new Error(body), {
      status: response.status,
    });
    throw new Error(`Could not fetch page (${response.status}). ${body.slice(0, 200)}`);
  }

  const markdown = await response.text();
  const title = extractTitle(markdown) ?? new URL(url).host;
  log('sources', 'fetchUrl.byok.response', { url, chars: markdown.length, title });
  return { title, markdown, url };
}

interface OpenmystFetchResponse {
  title?: string;
  url?: string;
  markdown?: string;
  content?: string;
}

async function openmystFetch(url: string): Promise<FetchedPage> {
  const token = getAuthTokenSync();
  if (!token) throw new Error('Sign in to add a link source.');
  const version = app.getVersion();

  log('sources', 'fetchUrl.openmyst.request', { url });

  const response = await fetch(`${OPENMYST_API_BASE_URL}/api/v1/fetch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': `openmyst-desktop/${version} (${platform()}-${arch()})`,
      'X-Client-Version': version,
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let code = '';
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? '';
    } catch {
      /* non-JSON body */
    }
    if (response.status === 401 && (code === 'invalid_token' || code === 'token_revoked')) {
      void invalidateToken(code);
    }
    logError('sources', 'fetchUrl.openmyst.http.failed', new Error(text), {
      status: response.status,
      code,
    });
    throw new Error(`Could not fetch page (${response.status}). ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as OpenmystFetchResponse;
  const markdown = (data.markdown ?? data.content ?? '').trim();
  if (!markdown) throw new Error('Fetched page was empty.');
  const title =
    (typeof data.title === 'string' && data.title.length > 0 ? data.title : null) ??
    extractTitle(markdown) ??
    new URL(url).host;

  refreshAfterRequest();
  log('sources', 'fetchUrl.openmyst.response', { url, chars: markdown.length, title });
  return { title, markdown, url: typeof data.url === 'string' ? data.url : url };
}

function extractTitle(md: string): string | null {
  // Jina Reader prepends a "Title:" line; fall back to the first markdown H1.
  const titleLine = md.match(/^\s*Title:\s*(.+)$/m);
  if (titleLine) return titleLine[1]!.trim();
  const h1 = md.match(/^\s*#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  return null;
}
