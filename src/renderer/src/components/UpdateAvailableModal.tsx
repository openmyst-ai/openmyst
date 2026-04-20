import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/types';
import { bridge } from '../api/bridge';

/**
 * Startup-time "update available" popup. Sits on top of the app and shows
 * whenever the background updater has found a newer version — whether it's
 * still downloading or already downloaded and waiting for a restart. Users
 * were missing updates entirely because the only surface was buried in
 * Settings → Updates.
 *
 * Dismissal is versioned (`update-dismissed:<availableVersion>` in
 * localStorage) so clicking "Later" hides the popup until there's a newer
 * version to surface. A user who downloads an update, declines to restart,
 * and closes the app keeps the downloaded state — next launch, the popup
 * comes back with "Restart & install" primed.
 */

const DISMISS_KEY_PREFIX = 'update-dismissed:';

function wasDismissed(version: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY_PREFIX + version) === '1';
  } catch {
    return false;
  }
}

function markDismissed(version: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY_PREFIX + version, '1');
  } catch {
    // Private-mode / storage-disabled — popup just re-appears next launch.
  }
}

export function UpdateAvailableModal(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void bridge.updater.getStatus().then((s) => {
      if (mounted) setStatus(s);
    });
    const off = bridge.updater.onChanged(() => {
      void bridge.updater.getStatus().then((s) => {
        if (mounted) setStatus(s);
      });
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  if (!status) return null;
  const { state, availableVersion, progressPercent } = status;

  // Only surface when there's actually a newer build in flight or ready.
  // `available` / `downloading` / `downloaded` are the three "user should
  // know" states; everything else stays silent.
  const relevant =
    state === 'available' || state === 'downloading' || state === 'downloaded';
  if (!relevant) return null;
  if (!availableVersion) return null;
  if (dismissed) return null;
  if (wasDismissed(availableVersion)) return null;

  const install = async (): Promise<void> => {
    setBusy(true);
    try {
      await bridge.updater.downloadAndInstall();
    } finally {
      setBusy(false);
    }
  };

  const later = (): void => {
    markDismissed(availableVersion);
    setDismissed(true);
  };

  const isDownloaded = state === 'downloaded';
  const isDownloading = state === 'downloading';

  return (
    <div className="modal-backdrop" onClick={later}>
      <div
        className="modal update-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Update available</h2>
        </div>
        <p>
          Open Myst <strong>v{availableVersion}</strong> is{' '}
          {isDownloaded ? 'ready to install' : 'downloading'}.
        </p>
        {isDownloading && (
          <div className="update-modal-progress">
            <div
              className="update-modal-progress-bar"
              style={{ width: `${progressPercent ?? 0}%` }}
            />
            <span className="muted update-modal-progress-label">
              {progressPercent != null ? `${progressPercent}%` : 'Starting…'}
            </span>
          </div>
        )}
        <div className="row update-modal-actions">
          <button type="button" onClick={later} disabled={busy}>
            Later
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void install()}
            disabled={busy || !isDownloaded}
            title={
              isDownloaded
                ? 'Relaunch to install the new version'
                : 'Waiting for download to finish'
            }
          >
            {isDownloaded ? 'Restart & install' : 'Downloading…'}
          </button>
        </div>
      </div>
    </div>
  );
}
