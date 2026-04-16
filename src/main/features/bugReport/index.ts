import { app, shell } from 'electron';
import { platform, arch, release } from 'node:os';
import { getRecentLogsText, log, logError, logFromRenderer } from '../../platform';

/**
 * Bug reporting.
 *
 * Primary path: POST the built markdown body to a Cloudflare Worker
 * (`WORKER_URL`) which holds a GitHub PAT and creates the issue on behalf of
 * a bot account. This lets end-users file bugs without a GitHub account of
 * their own. See `tools/bug-report-worker/` for the worker source and
 * deploy steps.
 *
 * Fallback path: if the worker is unreachable, unconfigured, or returns an
 * error, open a pre-filled `issues/new` URL in the user's browser so they
 * can at least post manually. Never leaves the user with a dead-end.
 *
 * The worker path sends a body of a few KB; the browser fallback is capped
 * by GitHub's URL length limit (~8 KB), so we still budget log space and
 * truncate from the front.
 */

/**
 * Repository that receives bug reports. Used for the browser-fallback URL
 * and shown to the user on success. Worker uses its own `GITHUB_REPO` var.
 */
const GITHUB_REPO = 'openmyst-ai/openmyst';

/**
 * Cloudflare Worker endpoint that relays reports to the GitHub API. Leave
 * blank to disable the worker path and fall straight through to the browser
 * flow (useful for local dev before the worker is deployed).
 */
const WORKER_URL = 'https://openmyst-bug-report.chawla-arsh.workers.dev';

/**
 * Optional shared secret. Must match the worker's `SHARED_SECRET` env var.
 * Raises the bar for drive-by spam; anyone who unpacks the app binary can
 * still read it, so don't treat it as real auth.
 */
const SHARED_SECRET = '';

const MAX_URL_BYTES = 7500;
const BUG_LABEL = 'bug';

export interface BugReportInput {
  title: string;
  description: string;
}

export interface BugReportPreview {
  title: string;
  body: string;
  deliveryMode: 'worker' | 'browser';
}

export interface BugReportResult {
  /** URL of the created or pre-filled issue. Always populated. */
  issueUrl: string;
  /** Issue number when the worker path succeeded. Null on the browser fallback. */
  issueNumber: number | null;
  /**
   * How the report was actually delivered:
   *   - 'worker' — posted via the relay worker, issue already exists on GitHub
   *   - 'browser' — opened a pre-filled issues/new URL; user still has to click submit
   */
  delivered: 'worker' | 'browser';
  /** Populated when we fell back to the browser after a worker error. */
  workerError?: string;
}

interface EnvInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  os: string;
  osRelease: string;
  arch: string;
}

function collectEnv(): EnvInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    os: platform(),
    osRelease: release(),
    arch: arch(),
  };
}

function formatEnv(env: EnvInfo): string {
  return [
    `- App: ${env.appVersion}`,
    `- Electron: ${env.electronVersion}`,
    `- Chrome: ${env.chromeVersion}`,
    `- Node: ${env.nodeVersion}`,
    `- OS: ${env.os} ${env.osRelease} (${env.arch})`,
  ].join('\n');
}

/**
 * Build the issue body (markdown). Logs are placed last so they can be
 * truncated from the front without losing the user's description. The
 * `logBudget` parameter controls how much log text to keep — the worker
 * path can afford a generous budget (~50 KB), the browser fallback cannot.
 */
export function buildIssueBody(
  input: BugReportInput,
  env: EnvInfo,
  logsText: string,
  logBudget: number,
): string {
  const description = input.description.trim() || '_(no description provided)_';

  const header = [
    '## Description',
    '',
    description,
    '',
    '## Environment',
    '',
    formatEnv(env),
    '',
    '## Recent logs',
    '',
    '```',
  ].join('\n');

  const footer = '\n```\n';

  let logs = logsText;
  let truncated = false;
  if (logs.length > logBudget) {
    logs = logs.slice(-logBudget);
    truncated = true;
  }

  const logsBlock = truncated
    ? `[… earlier log lines truncated. Full logs are in the terminal running \`npm run dev\`.]\n${logs}`
    : logs || '(no log activity captured in this session)';

  return header + '\n' + logsBlock + footer;
}

/** Generous log budget — worker accepts up to ~60 KB per request. */
const WORKER_LOG_BUDGET = 50_000;
/** Tight log budget — browser fallback rides GitHub's URL length cap. */
const BROWSER_LOG_BUDGET = 3_000;

function buildBrowserUrl(title: string, body: string): string {
  const params = new URLSearchParams({
    title: title.trim() || 'Bug report',
    body,
    labels: BUG_LABEL,
  });
  return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
}

/**
 * Produce the markdown that will be sent. The modal calls this before
 * submit so the user can see exactly what leaves the app — especially the
 * logs attachment. `deliveryMode` is reported so the UI can message the
 * difference between "posted directly" and "open in browser".
 */
export function previewBugReport(input: BugReportInput): BugReportPreview {
  const env = collectEnv();
  const logsText = getRecentLogsText();
  const useWorker = WORKER_URL.length > 0;
  const budget = useWorker ? WORKER_LOG_BUDGET : BROWSER_LOG_BUDGET;
  const body = buildIssueBody(input, env, logsText, budget);
  return {
    title: input.title.trim() || 'Bug report',
    body,
    deliveryMode: useWorker ? 'worker' : 'browser',
  };
}

async function submitViaWorker(title: string, body: string): Promise<BugReportResult> {
  // Worker exposes the create-issue handler at `/report`; the bare root 404s.
  const endpoint = WORKER_URL.replace(/\/+$/, '') + '/report';
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      body,
      labels: [BUG_LABEL],
      ...(SHARED_SECRET ? { clientToken: SHARED_SECRET } : {}),
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Worker ${resp.status}: ${detail.slice(0, 200) || resp.statusText}`);
  }

  const data = (await resp.json()) as { issueUrl?: string; issueNumber?: number };
  if (!data.issueUrl) {
    throw new Error('Worker accepted the report but returned no issueUrl.');
  }

  return {
    issueUrl: data.issueUrl,
    issueNumber: data.issueNumber ?? null,
    delivered: 'worker',
  };
}

async function submitViaBrowser(
  title: string,
  body: string,
  workerError?: string,
): Promise<BugReportResult> {
  // Re-budget logs for the URL cap — the worker-path body may be too big to
  // fit in a query string. Passing the already-built body through would blow
  // past GitHub's ~8 KB limit.
  const env = collectEnv();
  const logsText = getRecentLogsText();
  const shortBody = buildIssueBody(
    { title, description: extractDescriptionFromBody(body) },
    env,
    logsText,
    BROWSER_LOG_BUDGET,
  );

  let url = buildBrowserUrl(title, shortBody);
  if (url.length > MAX_URL_BYTES) {
    // Defensive re-shrink if somehow still over the cap.
    const tighter = buildIssueBody(
      { title, description: extractDescriptionFromBody(body) },
      env,
      logsText.slice(-1000),
      BROWSER_LOG_BUDGET,
    );
    url = buildBrowserUrl(title, tighter);
  }

  await shell.openExternal(url);
  return {
    issueUrl: url,
    issueNumber: null,
    delivered: 'browser',
    ...(workerError ? { workerError } : {}),
  };
}

/**
 * Pull the description section back out of a built body so the browser
 * fallback can re-assemble with a tighter log budget. The body always starts
 * with `## Description\n\n<desc>\n\n## Environment`, so we slice between those
 * markers.
 */
function extractDescriptionFromBody(body: string): string {
  const start = body.indexOf('## Description\n\n');
  if (start === -1) return '';
  const after = body.slice(start + '## Description\n\n'.length);
  const end = after.indexOf('\n\n## Environment');
  if (end === -1) return after.trim();
  return after.slice(0, end).trim();
}

export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  if (!input.title.trim()) throw new Error('Bug report title is required.');

  const title = input.title.trim();
  const env = collectEnv();
  const logsText = getRecentLogsText();

  if (WORKER_URL.length > 0) {
    const workerBody = buildIssueBody(input, env, logsText, WORKER_LOG_BUDGET);
    try {
      const result = await submitViaWorker(title, workerBody);
      log('bug', 'submit.worker', {
        titlePreview: title.slice(0, 60),
        issueNumber: result.issueNumber,
      });
      return result;
    } catch (err) {
      logError('bug', 'submit.workerFailed', err);
      const result = await submitViaBrowser(title, workerBody, (err as Error).message);
      return result;
    }
  }

  const browserBody = buildIssueBody(input, env, logsText, BROWSER_LOG_BUDGET);
  const result = await submitViaBrowser(title, browserBody);
  log('bug', 'submit.browser', {
    titlePreview: title.slice(0, 60),
    urlChars: result.issueUrl.length,
  });
  return result;
}

/** Exposed so the renderer can ship its own errors into the ring buffer. */
export function recordRendererLog(scope: string, event: string, message: string): void {
  logFromRenderer(scope, event, message);
}
