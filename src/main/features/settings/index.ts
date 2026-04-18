import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '@shared/types';
import { DEFAULT_DEEP_PLAN_MODEL, DEFAULT_MODEL } from '@shared/types';

/**
 * User-wide settings, stored outside any project. Lives at
 * `<userData>/settings.json` — on macOS that's
 * `~/Library/Application Support/openmyst/settings.json`.
 *
 * The OpenRouter API key is encrypted at rest via Electron's `safeStorage`
 * (keychain on macOS, DPAPI on Windows, libsecret on Linux). We store the
 * cipher as base64 inside the same JSON; the plaintext never touches disk.
 */

interface StoredSettings {
  defaultModel: string;
  deepPlanModel: string;
  openRouterKeyCipher: string | null;
  jinaKeyCipher: string | null;
  recentProjects: string[];
  workspaceRoot: string | null;
}

const DEFAULTS: StoredSettings = {
  defaultModel: DEFAULT_MODEL,
  deepPlanModel: DEFAULT_DEEP_PLAN_MODEL,
  openRouterKeyCipher: null,
  jinaKeyCipher: null,
  recentProjects: [],
  workspaceRoot: null,
};

/**
 * Where we suggest the user keep their projects on first launch.
 * `~/Documents/Open Myst` is friendly to non-power users (visible in Finder,
 * obvious purpose) and avoids the dot-prefixed home dir convention which
 * isn't discoverable on macOS/Windows.
 */
function defaultWorkspaceRoot(): string {
  return join(app.getPath('documents'), 'OpenMyst');
}

const MAX_RECENTS = 10;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

async function readStored(): Promise<StoredSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

async function writeStored(stored: StoredSettings): Promise<void> {
  const path = settingsPath();
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(stored, null, 2), 'utf-8');
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await readStored();
  return {
    defaultModel: stored.defaultModel,
    deepPlanModel: stored.deepPlanModel,
    hasOpenRouterKey: stored.openRouterKeyCipher !== null,
    hasJinaKey: stored.jinaKeyCipher !== null,
    recentProjects: stored.recentProjects,
    workspaceRoot: stored.workspaceRoot,
    defaultWorkspaceRoot: defaultWorkspaceRoot(),
  };
}

export async function getWorkspaceRoot(): Promise<string | null> {
  const stored = await readStored();
  return stored.workspaceRoot;
}

export async function setWorkspaceRoot(path: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, workspaceRoot: path });
}

export async function setOpenRouterKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available; cannot store API key securely.');
  }
  const stored = await readStored();
  const cipher = safeStorage.encryptString(key).toString('base64');
  await writeStored({ ...stored, openRouterKeyCipher: cipher });
}

export async function getOpenRouterKey(): Promise<string | null> {
  const stored = await readStored();
  if (!stored.openRouterKeyCipher) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  const buf = Buffer.from(stored.openRouterKeyCipher, 'base64');
  return safeStorage.decryptString(buf);
}

export async function clearOpenRouterKey(): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, openRouterKeyCipher: null });
}

export async function setDefaultModel(model: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, defaultModel: model });
}

export async function setJinaKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available; cannot store API key securely.');
  }
  const stored = await readStored();
  const cipher = safeStorage.encryptString(key).toString('base64');
  await writeStored({ ...stored, jinaKeyCipher: cipher });
}

export async function getJinaKey(): Promise<string | null> {
  const stored = await readStored();
  if (!stored.jinaKeyCipher) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  const buf = Buffer.from(stored.jinaKeyCipher, 'base64');
  return safeStorage.decryptString(buf);
}

export async function clearJinaKey(): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, jinaKeyCipher: null });
}

export async function setDeepPlanModel(model: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, deepPlanModel: model });
}

export async function getDeepPlanModel(): Promise<string> {
  const stored = await readStored();
  return stored.deepPlanModel;
}

export async function pushRecentProject(path: string): Promise<void> {
  const stored = await readStored();
  const next = [path, ...stored.recentProjects.filter((p) => p !== path)].slice(0, MAX_RECENTS);
  await writeStored({ ...stored, recentProjects: next });
}
