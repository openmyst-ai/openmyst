import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '@shared/types';
import {
  DEFAULT_CHAIR_MODEL,
  DEFAULT_DEEP_PLAN_MODEL,
  DEFAULT_DRAFT_MODEL,
  DEFAULT_MODEL,
  DEFAULT_PANEL_MODEL,
  DEFAULT_SUMMARY_MODEL,
} from '@shared/types';

/**
 * User-wide settings, stored outside any project. Lives at
 * `<userData>/settings.json` — on macOS that's
 * `~/Library/Application Support/openmyst/settings.json`.
 *
 * The OpenRouter API key is encrypted at rest via Electron's `safeStorage`
 * (keychain on macOS, DPAPI on Windows, libsecret on Linux). We store the
 * cipher as base64 inside the same JSON; the plaintext never touches disk.
 */

/**
 * Bump this when you want every existing user's model slots force-reset to
 * the current DEFAULT_* values on next app launch. Used to roll out new
 * model defaults without leaving users stuck on whatever they'd manually
 * configured. The reset runs once per bump — subsequent reads see the
 * updated version and skip.
 *
 *   v1 — 2026-04: reset to gemma-4-31b-it + gemini-2.5-flash-lite defaults
 *        after the panel/summary/chair/draft slot split landed.
 */
const CURRENT_MODEL_DEFAULTS_VERSION = 1;

interface StoredSettings {
  defaultModel: string;
  /**
   * Legacy field — the single Deep Plan model before the Phase 1 split.
   * Still written so older app builds can read the file, but Deep Plan
   * internals now use `chairModel` and `draftModel`. Migration: on read,
   * if `chairModel` or `draftModel` is missing, we copy `deepPlanModel`
   * into them so the user's prior pick carries forward.
   */
  deepPlanModel: string;
  chairModel: string;
  draftModel: string;
  panelModel: string;
  summaryModel: string;
  /**
   * Last defaults-version applied for this user. When lower than
   * CURRENT_MODEL_DEFAULTS_VERSION, the five model slots above get
   * force-reset to DEFAULT_* on next read. 0 = never applied (fresh
   * users + anyone whose settings predate the field).
   */
  modelDefaultsVersion: number;
  openRouterKeyCipher: string | null;
  jinaKeyCipher: string | null;
  recentProjects: string[];
  workspaceRoot: string | null;
}

const DEFAULTS: StoredSettings = {
  defaultModel: DEFAULT_MODEL,
  deepPlanModel: DEFAULT_DEEP_PLAN_MODEL,
  chairModel: DEFAULT_CHAIR_MODEL,
  draftModel: DEFAULT_DRAFT_MODEL,
  panelModel: DEFAULT_PANEL_MODEL,
  summaryModel: DEFAULT_SUMMARY_MODEL,
  modelDefaultsVersion: CURRENT_MODEL_DEFAULTS_VERSION,
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
    const migrated: StoredSettings = { ...DEFAULTS, ...parsed };

    // Phase-1 migration: if the user's settings predate chair/draft split,
    // carry their prior `deepPlanModel` forward into both new slots so the
    // upgrade is invisible. (Only matters for existing users on bumps
    // below CURRENT_MODEL_DEFAULTS_VERSION; the force-reset below will
    // overwrite these anyway on the initial rollout, but the soft-copy
    // keeps things sane if someone hand-edits settings.json.)
    if (parsed.chairModel === undefined && typeof parsed.deepPlanModel === 'string') {
      migrated.chairModel = parsed.deepPlanModel;
    }
    if (parsed.draftModel === undefined && typeof parsed.deepPlanModel === 'string') {
      migrated.draftModel = parsed.deepPlanModel;
    }
    // Split panel model out from summary model for existing users — their
    // panel previously shared summaryModel.
    if (parsed.panelModel === undefined && typeof parsed.summaryModel === 'string') {
      migrated.panelModel = parsed.summaryModel;
    }

    // Force-reset model slots on defaults-version bump. Triggered for
    // users whose stored version is older than CURRENT — typically right
    // after they install an app update that declared new defaults. Runs
    // exactly once: we write the new version back immediately so
    // subsequent reads skip the branch.
    const storedDefaultsVersion =
      typeof parsed.modelDefaultsVersion === 'number' ? parsed.modelDefaultsVersion : 0;
    if (storedDefaultsVersion < CURRENT_MODEL_DEFAULTS_VERSION) {
      migrated.defaultModel = DEFAULT_MODEL;
      migrated.deepPlanModel = DEFAULT_DEEP_PLAN_MODEL;
      migrated.chairModel = DEFAULT_CHAIR_MODEL;
      migrated.draftModel = DEFAULT_DRAFT_MODEL;
      migrated.panelModel = DEFAULT_PANEL_MODEL;
      migrated.summaryModel = DEFAULT_SUMMARY_MODEL;
      migrated.modelDefaultsVersion = CURRENT_MODEL_DEFAULTS_VERSION;
      // Persist the reset so the next read doesn't repeat it. Fire-and-
      // forget; a failure here just means we try again next launch.
      void writeStored(migrated).catch(() => {
        /* ignore — non-fatal */
      });
    }

    return migrated;
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
    chairModel: stored.chairModel,
    draftModel: stored.draftModel,
    panelModel: stored.panelModel,
    summaryModel: stored.summaryModel,
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
  // Legacy setter — kept for backward compat with any caller that still
  // speaks the pre-split API. Writes BOTH new slots so the user's intent
  // (one Deep Plan model) is reflected post-split.
  const stored = await readStored();
  await writeStored({
    ...stored,
    deepPlanModel: model,
    chairModel: model,
    draftModel: model,
  });
}

export async function getDeepPlanModel(): Promise<string> {
  // Legacy getter — returns chairModel for the deepSearch planner path
  // that still consumes the old API. Safe because Chair is the "planner"
  // role in spirit.
  const stored = await readStored();
  return stored.chairModel;
}

export async function setChairModel(model: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, chairModel: model });
}

export async function getChairModel(): Promise<string> {
  const stored = await readStored();
  return stored.chairModel;
}

export async function setDraftModel(model: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, draftModel: model });
}

export async function getDraftModel(): Promise<string> {
  const stored = await readStored();
  return stored.draftModel;
}

export async function setSummaryModel(model: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, summaryModel: model });
}

export async function getSummaryModel(): Promise<string> {
  const stored = await readStored();
  return stored.summaryModel;
}

export async function setPanelModel(model: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, panelModel: model });
}

export async function getPanelModel(): Promise<string> {
  const stored = await readStored();
  return stored.panelModel;
}

export async function pushRecentProject(path: string): Promise<void> {
  const stored = await readStored();
  const next = [path, ...stored.recentProjects.filter((p) => p !== path)].slice(0, MAX_RECENTS);
  await writeStored({ ...stored, recentProjects: next });
}
