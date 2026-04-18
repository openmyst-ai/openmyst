import { app, safeStorage, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { URL } from 'node:url';
import { OPENMYST_API_BASE_URL, OPENMYST_DEEP_LINK_SCHEME } from '@shared/flags';
import { broadcast, log, logError } from '../../platform';
import { IpcChannels } from '@shared/ipc-channels';

/**
 * Auth feature — owns the signed-in token that is used for every
 * `openmyst.ai/api/v1/*` request.
 *
 * The actual sign-in happens in the user's browser on openmyst.ai (Supabase
 * UI lives there). We kick that off with `signIn`, then either the deep-link
 * path calls `completeSignIn(token)` when the browser redirects back to
 * `openmyst://auth-callback`, or the user pastes the token manually via
 * `pasteToken`.
 *
 * Token is stored encrypted via Electron's `safeStorage` (keychain on macOS,
 * DPAPI on Windows, libsecret on Linux). We re-use the same `<userData>`
 * folder the rest of the app writes to — one small JSON file, plaintext never
 * touches disk.
 */

interface StoredAuth {
  tokenCipher: string | null;
}

const DEFAULTS: StoredAuth = { tokenCipher: null };

function storePath(): string {
  return join(app.getPath('userData'), 'auth.json');
}

async function readStored(): Promise<StoredAuth> {
  try {
    const raw = await fs.readFile(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

async function writeStored(stored: StoredAuth): Promise<void> {
  const path = storePath();
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(stored, null, 2), 'utf-8');
}

/**
 * In-memory CSRF guard: the state string we generated for the most recent
 * `signIn` call. Matched against whatever comes back from the deep-link.
 * Cleared after a successful or failed handoff.
 */
let pendingState: string | null = null;

/** Cached plaintext token so hot paths (every chat turn) don't decrypt. */
let cachedToken: string | null = null;
let cacheLoaded = false;

export interface AuthStatus {
  signedIn: boolean;
}

function notifyChanged(): void {
  broadcast(IpcChannels.Auth.Changed);
}

/**
 * HTTP header values must be Latin-1 (ByteString) — anything >0xFF makes
 * undici throw before the request leaves the process. We saw tokens arrive
 * with U+2026 HORIZONTAL ELLIPSIS embedded (most likely from a "smart
 * punctuation" auto-replace or a copy from a visually-truncated UI). A token
 * that fails this check is unusable for `Authorization: Bearer …`, so treat
 * it as invalid and make the user sign in again rather than letting every
 * `/me` refresh crash for eternity.
 */
function isHeaderSafe(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  try {
    const stored = await readStored();
    if (stored.tokenCipher && safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(stored.tokenCipher, 'base64');
      const decrypted = safeStorage.decryptString(buf);
      if (isHeaderSafe(decrypted)) {
        cachedToken = decrypted;
      } else {
        // Poisoned token on disk — almost certainly a paste of a display-
        // truncated value with a literal ellipsis. Clear it so the app
        // returns to the sign-in screen instead of looping on refresh errors.
        logError('auth', 'cache.load.rejected', new Error('Stored token has non-ASCII characters'));
        cachedToken = null;
        await writeStored({ ...stored, tokenCipher: null }).catch((err) =>
          logError('auth', 'cache.clear.failed', err),
        );
      }
    } else {
      cachedToken = null;
    }
  } catch (err) {
    logError('auth', 'cache.load.failed', err);
    cachedToken = null;
  }
  cacheLoaded = true;
}

/** Fast synchronous-ish read for API clients. Load first via `initAuth`. */
export function getAuthTokenSync(): string | null {
  return cachedToken;
}

/** Async variant used by the IPC layer. */
export async function getAuthToken(): Promise<string | null> {
  await loadCache();
  return cachedToken;
}

export async function getStatus(): Promise<AuthStatus> {
  await loadCache();
  return { signedIn: cachedToken !== null };
}

export async function initAuth(): Promise<void> {
  await loadCache();
}

/**
 * Kick off sign-in. Generates a CSRF state, stashes it in memory, and opens
 * the user's browser to the web-side login page. The web page ultimately
 * redirects to `openmyst://auth-callback?state=…&token=…`, which the OS
 * hands back to the main process via `completeSignIn` below.
 */
export async function signIn(): Promise<{ loginUrl: string }> {
  const state = randomBytes(32).toString('hex');
  pendingState = state;

  const redirect = `${OPENMYST_DEEP_LINK_SCHEME}://auth-callback`;
  const loginUrl = `${OPENMYST_API_BASE_URL}/app-login?state=${encodeURIComponent(state)}&redirect=${encodeURIComponent(redirect)}`;

  log('auth', 'signIn.open', { statePrefix: state.slice(0, 8) });
  await shell.openExternal(loginUrl);
  return { loginUrl };
}

/**
 * Handle a deep-link callback of the form
 * `openmyst://auth-callback?state=…&token=…`. Exposed so the main-process
 * deep-link listener can forward URLs it receives.
 */
export async function completeSignInFromUrl(rawUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    log('auth', 'callback.badUrl', { preview: rawUrl.slice(0, 80) });
    return false;
  }
  // `openmyst://auth-callback` — host is `auth-callback`. Don't be fussy
  // about trailing slashes.
  if (parsed.protocol !== `${OPENMYST_DEEP_LINK_SCHEME}:`) return false;
  if (parsed.hostname !== 'auth-callback' && parsed.pathname !== '//auth-callback') return false;

  const state = parsed.searchParams.get('state');
  const token = parsed.searchParams.get('token');
  if (!state || !token) {
    log('auth', 'callback.missingFields', {
      hasState: Boolean(state),
      hasToken: Boolean(token),
    });
    return false;
  }
  if (!isHeaderSafe(token)) {
    // URL round-trip should never introduce smart ellipsis, so this is a
    // backend/transport bug worth logging rather than silently recovering.
    logError('auth', 'callback.nonAsciiToken', new Error('Deep-link token has non-ASCII characters'));
    return false;
  }

  if (!pendingState || state !== pendingState) {
    log('auth', 'callback.stateMismatch', {
      expectedPrefix: pendingState?.slice(0, 8) ?? null,
      gotPrefix: state.slice(0, 8),
    });
    return false;
  }
  pendingState = null;

  await persistToken(token);
  log('auth', 'callback.ok', { tokenPrefix: token.slice(0, 8) });
  notifyChanged();
  return true;
}

/**
 * Manual fallback — user pastes the token directly into the desktop app
 * login screen. No CSRF check here: the web page guarded the token behind
 * Supabase auth, and pasting it by hand means the user explicitly opted in.
 */
export async function pasteToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Token must be a non-empty string.');
  if (!isHeaderSafe(trimmed)) {
    // Most common cause: the user copied a display-truncated value with a
    // literal "…" ellipsis, or smart-punctuation rewrote "..." → "…". Either
    // way the token can't be used as an HTTP header — reject loudly instead
    // of storing it and failing on every future request.
    throw new Error(
      'Token contains non-ASCII characters (likely an ellipsis "…" from a truncated copy). ' +
        'Copy the full token from the dashboard and paste it again.',
    );
  }
  await persistToken(trimmed);
  log('auth', 'paste.ok', { tokenPrefix: trimmed.slice(0, 8) });
  notifyChanged();
}

async function persistToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available; cannot store token securely.');
  }
  const cipher = safeStorage.encryptString(token).toString('base64');
  const stored = await readStored();
  await writeStored({ ...stored, tokenCipher: cipher });
  cachedToken = token;
  cacheLoaded = true;
}

/**
 * Clear the token locally. Server-side revocation is dashboard-only in v1
 * (see changes.md §2.3 / §4.4).
 */
export async function signOut(): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, tokenCipher: null });
  cachedToken = null;
  cacheLoaded = true;
  pendingState = null;
  log('auth', 'signOut.ok', {});
  notifyChanged();
}

/**
 * Drop the local token because the server said the token is invalid. Same
 * effect as `signOut` but logged differently so the support path can tell
 * the two apart.
 */
export async function invalidateToken(reason: 'invalid_token' | 'token_revoked'): Promise<void> {
  await signOut();
  log('auth', 'invalidate', { reason });
}
