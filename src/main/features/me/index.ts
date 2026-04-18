import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { IpcChannels } from '@shared/ipc-channels';
import { OPENMYST_API_BASE_URL, USE_OPENMYST } from '@shared/flags';
import type { MeQuotaBucket, MeSnapshot, MeStatus } from '@shared/types';
import { broadcast, log, logError } from '../../platform';
import { getAuthTokenSync, invalidateToken } from '../auth';

/**
 * `/api/v1/me` feature — owns the cached snapshot of the signed-in user's
 * account, quota counters, and currently-routed model (changes.md §4.3). The
 * renderer subscribes via `me.onChanged` and paints quota pills + an
 * approaching-limit banner from the cached snapshot.
 *
 * Refresh policy:
 *   - On sign-in (wired from auth).
 *   - After every chat/search turn (called by the LLM + search facades).
 *   - On an explicit `me.refresh` IPC call (user-initiated).
 *   - Otherwise throttled: we won't hit the network more than once every
 *     `MIN_REFRESH_INTERVAL_MS` unless the caller passes `force`.
 *
 * Offline behaviour: if a refresh fails and we have a cached snapshot on disk
 * that's under 24h old, we surface that with `offline: true` instead of
 * nuking the UI (changes.md §10).
 *
 * In BYOK dev mode (flag = false) this feature is a no-op — nothing to fetch,
 * nothing to show. The status always reports `snapshot: null`.
 */

const MIN_REFRESH_INTERVAL_MS = 30_000;
const OFFLINE_STALE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface StoredMe {
  snapshot: MeSnapshot | null;
}

let cached: MeSnapshot | null = null;
let offline = false;
let loading = false;
let lastError: string | null = null;
let lastFetchAttempt = 0;
let loadedFromDisk = false;
/**
 * True when a `refreshAfterRequest` fired while another refresh was already
 * in-flight. We only run one at a time, but a queued follow-up runs right
 * after the current one so bursts of chats/searches (e.g. Deep Plan's
 * research loop) never leave the final request's counter unreflected.
 */
let pendingRefresh = false;

function storePath(): string {
  return join(app.getPath('userData'), 'me.json');
}

async function readStored(): Promise<StoredMe> {
  try {
    const raw = await fs.readFile(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredMe>;
    return { snapshot: parsed.snapshot ?? null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { snapshot: null };
    throw err;
  }
}

async function writeStored(stored: StoredMe): Promise<void> {
  const path = storePath();
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(stored, null, 2), 'utf-8');
}

function notifyChanged(): void {
  broadcast(IpcChannels.Me.Changed);
}

async function loadFromDisk(): Promise<void> {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const stored = await readStored();
    if (stored.snapshot) {
      cached = stored.snapshot;
      // A disk snapshot is always considered offline until we confirm fresh
      // state with a successful fetch — the app may have crashed mid-session
      // or come back online with different plan/quota numbers.
      offline = true;
    }
  } catch (err) {
    logError('me', 'disk.load.failed', err);
  }
}

export async function initMe(): Promise<void> {
  if (!USE_OPENMYST) return;
  await loadFromDisk();
  if (getAuthTokenSync()) {
    // Kick off a silent refresh on launch — don't block startup on it.
    void refreshMe({ silent: true });
  }
}

export function getStatus(): MeStatus {
  return { snapshot: cached, loading, error: lastError, offline };
}

interface ApiQuotaBucket {
  period?: string;
  limit?: number | null;
  used?: number;
  remaining?: number | null;
  resets_at?: string;
}

interface ApiMeResponse {
  user?: { id?: string; email?: string; email_verified?: boolean };
  plan?: string;
  quota?: { chat?: ApiQuotaBucket; search?: ApiQuotaBucket };
  rate_limit?: { requests_per_minute?: number };
  current_model?: { id?: string; name?: string; provider?: string };
}

function mapBucket(raw: ApiQuotaBucket | undefined): MeQuotaBucket {
  return {
    period: 'day',
    limit: typeof raw?.limit === 'number' ? raw.limit : null,
    used: typeof raw?.used === 'number' ? raw.used : 0,
    remaining: typeof raw?.remaining === 'number' ? raw.remaining : null,
    resetsAt: typeof raw?.resets_at === 'string' ? raw.resets_at : new Date().toISOString(),
  };
}

function mapResponse(data: ApiMeResponse): MeSnapshot {
  const current = data.current_model;
  return {
    user: {
      id: typeof data.user?.id === 'string' ? data.user.id : '',
      email: typeof data.user?.email === 'string' ? data.user.email : '',
      emailVerified: Boolean(data.user?.email_verified),
    },
    plan: typeof data.plan === 'string' ? data.plan : 'free',
    quota: {
      chat: mapBucket(data.quota?.chat),
      search: mapBucket(data.quota?.search),
    },
    rateLimit: {
      requestsPerMinute:
        typeof data.rate_limit?.requests_per_minute === 'number'
          ? data.rate_limit.requests_per_minute
          : 0,
    },
    currentModel:
      current && typeof current.id === 'string'
        ? {
            id: current.id,
            name: typeof current.name === 'string' ? current.name : current.id,
            provider: typeof current.provider === 'string' ? current.provider : '',
          }
        : null,
    fetchedAt: new Date().toISOString(),
  };
}

export interface RefreshOptions {
  /** Skip the throttle and fetch immediately. */
  force?: boolean;
  /** Don't broadcast while in-flight (used by bootstrap). */
  silent?: boolean;
}

export async function refreshMe(options: RefreshOptions = {}): Promise<MeStatus> {
  if (!USE_OPENMYST) return getStatus();
  await loadFromDisk();

  const token = getAuthTokenSync();
  if (!token) {
    // Signed out — drop any cached snapshot so the UI stops showing quota for
    // the previous account.
    if (cached) {
      cached = null;
      offline = false;
      await writeStored({ snapshot: null }).catch((err) =>
        logError('me', 'disk.clear.failed', err),
      );
      notifyChanged();
    }
    return getStatus();
  }

  // Belt-and-braces: `loadCache` scrubs non-ASCII tokens on startup, but if
  // one slips through (e.g. a token set by a previous build that didn't
  // validate) every fetch will throw a "Cannot convert argument to a
  // ByteString" TypeError forever. Invalidate proactively so the user is
  // routed back to sign-in instead of stuck on "Signing in…".
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) > 0xff) {
      logError('me', 'token.nonAscii', new Error('Cached token has non-ASCII characters'));
      await invalidateToken('invalid_token');
      cached = null;
      offline = false;
      lastError = 'Your saved token is corrupted — please sign in again.';
      loading = false;
      notifyChanged();
      return getStatus();
    }
  }

  const now = Date.now();
  if (!options.force && now - lastFetchAttempt < MIN_REFRESH_INTERVAL_MS && cached) {
    return getStatus();
  }
  lastFetchAttempt = now;

  if (loading) {
    // Drop-the-request path: mark that we need to refetch once the in-flight
    // call resolves. Don't bump lastFetchAttempt — the follow-up should still
    // be considered fresh.
    pendingRefresh = true;
    return getStatus();
  }
  loading = true;
  if (!options.silent) notifyChanged();

  try {
    const version = app.getVersion();
    const response = await fetch(`${OPENMYST_API_BASE_URL}/api/v1/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': `openmyst-desktop/${version} (${platform()}-${arch()})`,
        'X-Client-Version': version,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let code = '';
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string } };
        code = parsed.error?.code ?? '';
      } catch {
        /* non-JSON */
      }
      if (response.status === 401 && (code === 'invalid_token' || code === 'token_revoked')) {
        await invalidateToken(code);
        cached = null;
        offline = false;
        lastError = 'Signed out — your session has ended.';
        return getStatus();
      }
      // Keep any cached snapshot so we degrade gracefully on transient 5xx.
      offline = cached !== null;
      lastError = `me.http.${response.status}`;
      logError('me', 'http.failed', new Error(text), { status: response.status, code });
      return getStatus();
    }

    const data = (await response.json()) as ApiMeResponse;
    const snapshot = mapResponse(data);

    // Drop the on-disk cache if it's older than 24h — the offline window only
    // matters for reasonably fresh data.
    cached = snapshot;
    offline = false;
    lastError = null;
    log('me', 'refresh.ok', {
      plan: snapshot.plan,
      chatUsed: snapshot.quota.chat.used,
      chatRemaining: snapshot.quota.chat.remaining,
      searchUsed: snapshot.quota.search.used,
      searchRemaining: snapshot.quota.search.remaining,
    });
    await writeStored({ snapshot }).catch((err) => logError('me', 'disk.write.failed', err));
    return getStatus();
  } catch (err) {
    // Network failure: keep the cached snapshot only if it's within the
    // offline stale window.
    if (cached) {
      const age = Date.now() - Date.parse(cached.fetchedAt);
      if (!Number.isFinite(age) || age > OFFLINE_STALE_WINDOW_MS) {
        cached = null;
        offline = false;
      } else {
        offline = true;
      }
    }
    lastError = (err as Error).message ?? 'Network error';
    logError('me', 'refresh.failed', err);
    return getStatus();
  } finally {
    loading = false;
    notifyChanged();
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshMe({ force: true, silent: true });
    }
  }
}

/**
 * Called by the chat/search facades after a successful request so the UI
 * counters reflect reality. Best-effort: any failure is swallowed.
 */
export function refreshAfterRequest(): void {
  if (!USE_OPENMYST) return;
  void refreshMe({ force: true, silent: true });
}

/** Clear any cached snapshot and notify the renderer — used on sign-out. */
export async function clearMe(): Promise<void> {
  if (!cached && !offline && !lastError) return;
  cached = null;
  offline = false;
  lastError = null;
  await writeStored({ snapshot: null }).catch((err) =>
    logError('me', 'disk.clear.failed', err),
  );
  notifyChanged();
}
