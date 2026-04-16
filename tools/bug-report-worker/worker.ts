/**
 * Bug-report relay worker.
 *
 * Accepts a POST from the Open Myst app, validates shape + size, applies a
 * coarse per-IP rate limit, and calls the GitHub REST API to create an issue
 * on behalf of a bot account. This lets users file bugs without a GitHub
 * account of their own — the app ships with just a public worker URL, no
 * credentials.
 *
 * Request:
 *   POST /report
 *   Content-Type: application/json
 *   { title: string, body: string, labels?: string[], clientToken?: string }
 *
 * Response on success:
 *   200 { issueUrl: string, issueNumber: number }
 *
 * Response on rejection:
 *   400 — bad shape / size
 *   401 — clientToken mismatch (if SHARED_SECRET is configured)
 *   429 — rate-limited
 *   502 — GitHub upstream error (body includes `githubStatus`)
 *
 * Deploy with `wrangler deploy`. Env vars are set in the Cloudflare dashboard
 * or via `wrangler secret put`:
 *   GITHUB_TOKEN   — fine-grained PAT with `Issues: write` on the target repo
 *                     (or a GitHub App installation token)
 *   GITHUB_REPO    — `owner/repo`, e.g. `openmyst-ai/openmyst`
 *   SHARED_SECRET  — optional. If set, the app must include a matching
 *                     `clientToken` in the request. Raises the bar for spam;
 *                     doesn't stop a determined attacker who reads the binary.
 */

export interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  SHARED_SECRET?: string;
}

interface ReportBody {
  title: string;
  body: string;
  labels?: string[];
  clientToken?: string;
}

// Per-IP rate limit. In-memory means it resets on cold start and isn't shared
// across worker replicas — good enough to slow drive-by spam, not bulletproof.
// Upgrade to KV or a Durable Object if volume warrants it.
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX_PER_IP = 5;
const ipHits = new Map<string, number[]>();

const MAX_TITLE_LEN = 200;
const MAX_BODY_LEN = 60_000;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_PER_IP) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  return false;
}

function corsHeaders(origin: string | null): HeadersInit {
  // Electron's fetch sends Origin: null. Reflect whatever comes in so
  // browser-based tooling still works, and fall back to `*` for null.
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/report' || request.method !== 'POST') {
      return jsonResponse({ error: 'Not found' }, 404, origin);
    }

    const ip =
      request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-forwarded-for') ??
      'unknown';
    if (rateLimited(ip)) {
      return jsonResponse(
        { error: `Rate limit: max ${RATE_MAX_PER_IP} reports per hour per IP.` },
        429,
        origin,
      );
    }

    let parsed: ReportBody;
    try {
      parsed = (await request.json()) as ReportBody;
    } catch {
      return jsonResponse({ error: 'Body must be valid JSON.' }, 400, origin);
    }

    if (env.SHARED_SECRET && parsed.clientToken !== env.SHARED_SECRET) {
      return jsonResponse({ error: 'Missing or invalid clientToken.' }, 401, origin);
    }

    if (typeof parsed.title !== 'string' || parsed.title.trim().length === 0) {
      return jsonResponse({ error: 'title is required.' }, 400, origin);
    }
    if (typeof parsed.body !== 'string') {
      return jsonResponse({ error: 'body must be a string.' }, 400, origin);
    }
    if (parsed.title.length > MAX_TITLE_LEN) {
      return jsonResponse(
        { error: `title too long (max ${MAX_TITLE_LEN} chars).` },
        400,
        origin,
      );
    }
    if (parsed.body.length > MAX_BODY_LEN) {
      return jsonResponse(
        { error: `body too long (max ${MAX_BODY_LEN} chars).` },
        400,
        origin,
      );
    }

    const labels = Array.isArray(parsed.labels)
      ? parsed.labels.filter((l) => typeof l === 'string' && l.length > 0).slice(0, 5)
      : ['bug'];

    const ghResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'openmyst-bug-report-worker',
      },
      body: JSON.stringify({
        title: parsed.title.trim(),
        body: parsed.body,
        labels,
      }),
    });

    if (!ghResp.ok) {
      const text = await ghResp.text().catch(() => '');
      return jsonResponse(
        {
          error: 'GitHub API rejected the issue.',
          githubStatus: ghResp.status,
          githubBody: text.slice(0, 500),
        },
        502,
        origin,
      );
    }

    const issue = (await ghResp.json()) as { html_url?: string; number?: number };
    return jsonResponse(
      {
        issueUrl: issue.html_url ?? null,
        issueNumber: issue.number ?? null,
      },
      200,
      origin,
    );
  },
};
