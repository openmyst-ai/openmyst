import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IpcChannels } from '@shared/ipc-channels';
import type { UpdateStatus } from '@shared/types';
import { broadcast } from '../../platform/window';
import { log, logError } from '../../platform/log';

/**
 * Auto-update wiring on top of electron-updater + GitHub Releases. The flow:
 *
 *  1. `initUpdater()` runs at app startup. In dev (`!app.isPackaged`) it's a
 *     no-op — autoUpdater refuses to work unsigned anyway, and we don't want
 *     the dev binary trying to replace itself.
 *  2. ~15 s after launch we kick off a silent `checkForUpdates()`. If nothing's
 *     new, state stays `idle` and the user sees "You're up to date."
 *  3. On `update-available` we auto-download (electron-updater default). While
 *     downloading we stream progress to the renderer so Settings can show a
 *     bar. On `update-downloaded` we flip to `downloaded` and let the user
 *     click "Restart to install" in Settings. We deliberately do NOT call
 *     `quitAndInstall()` automatically — interrupting a writing session is
 *     a worse UX than a one-click banner.
 *  4. `check()` / `downloadAndInstall()` IPC handlers let the user drive the
 *     flow manually from Settings.
 *
 * Publish target is configured in `electron-builder.yml` (GitHub releases,
 * repo openmyst-ai/openmyst). No credentials required for public releases.
 */

const currentVersion = app.getVersion();

let status: UpdateStatus = {
  state: app.isPackaged ? 'idle' : 'disabled',
  currentVersion,
  availableVersion: null,
  progressPercent: null,
  error: null,
};

let wired = false;

function setStatus(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
  broadcast(IpcChannels.Updater.Changed);
}

function wireAutoUpdaterEvents(): void {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log('updater', 'info', { msg: String(m) }),
    warn: (m: unknown) => log('updater', 'warn', { msg: String(m) }),
    error: (m: unknown) => log('updater', 'error', { msg: String(m) }),
    debug: () => {},
  } as unknown as typeof autoUpdater.logger;

  autoUpdater.on('checking-for-update', () => {
    log('updater', 'checking');
    setStatus({ state: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    log('updater', 'available', { version: info?.version });
    setStatus({
      state: 'downloading',
      availableVersion: info?.version ?? null,
      progressPercent: 0,
      error: null,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    log('updater', 'not-available', { version: info?.version });
    setStatus({ state: 'not-available', availableVersion: null, error: null });
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = typeof progress?.percent === 'number' ? Math.round(progress.percent) : null;
    setStatus({ state: 'downloading', progressPercent: pct });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('updater', 'downloaded', { version: info?.version });
    setStatus({
      state: 'downloaded',
      availableVersion: info?.version ?? status.availableVersion,
      progressPercent: 100,
      error: null,
    });
  });

  autoUpdater.on('error', (err) => {
    logError('updater', 'error', err);
    setStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function initUpdater(): void {
  if (!app.isPackaged) {
    log('updater', 'init.skipped', { reason: 'unpackaged' });
    return;
  }
  wireAutoUpdaterEvents();
  // Delay the first check so it doesn't fight the main window's first paint
  // for bandwidth. 15 s is long enough for renderer + workspace load to
  // settle on a slow machine.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      logError('updater', 'initial-check.failed', err);
    });
  }, 15_000);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status;
  wireAutoUpdaterEvents();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    logError('updater', 'manual-check.failed', err);
    setStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return status;
}

export async function downloadAndInstall(): Promise<UpdateStatus> {
  if (!app.isPackaged) return status;
  if (status.state === 'downloaded') {
    // Give the renderer one tick to close cleanly before we yank the app out.
    setTimeout(() => autoUpdater.quitAndInstall(), 250);
    return status;
  }
  // If we somehow get called before a download completed, kick one off.
  wireAutoUpdaterEvents();
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    logError('updater', 'download.failed', err);
    setStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return status;
}
