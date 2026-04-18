import { useEffect, useState } from 'react';
import { USE_OPENMYST } from '@shared/flags';
import { MODEL_OPTIONS } from '@shared/types';
import type { UpdateStatus } from '@shared/types';
import { useApp } from '../store/app';
import { useAuth } from '../store/auth';
import { useMe } from '../store/me';
import { bridge } from '../api/bridge';
import { BugReportModal } from './BugReportModal';
import { formatTokens } from './QuotaPills';

export function SettingsModal(): JSX.Element {
  const { settings, closeSettings, refreshSettings } = useApp();
  const [key, setKey] = useState('');
  const [jinaKey, setJinaKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showBugReport, setShowBugReport] = useState(false);

  // One model drives both chat and Deep Plan/Search for launch — keeps the
  // UI simple and cost predictable. We use `defaultModel` as the source of
  // truth in the UI and mirror it to `deepPlanModel` on save.
  const currentModel = settings?.defaultModel ?? '';

  const saveKey = async (): Promise<void> => {
    setLocalError(null);
    setSaving(true);
    try {
      await bridge.settings.setOpenRouterKey(key);
      setKey('');
      await refreshSettings();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    setSaving(true);
    try {
      await bridge.settings.clearOpenRouterKey();
      await refreshSettings();
    } finally {
      setSaving(false);
    }
  };

  const changeModel = async (next: string): Promise<void> => {
    if (!next || next === currentModel) return;
    setLocalError(null);
    setSaving(true);
    try {
      await bridge.settings.setDefaultModel(next);
      await bridge.settings.setDeepPlanModel(next);
      await refreshSettings();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveJinaKey = async (): Promise<void> => {
    setLocalError(null);
    setSaving(true);
    try {
      await bridge.settings.setJinaKey(jinaKey);
      setJinaKey('');
      await refreshSettings();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clearJinaKey = async (): Promise<void> => {
    setSaving(true);
    try {
      await bridge.settings.clearJinaKey();
      await refreshSettings();
    } finally {
      setSaving(false);
    }
  };

  // The list the dropdown renders. If the current saved model is something
  // custom (not one of the curated options), surface it so the user can see
  // what's selected without us silently rewriting their config.
  const optionsWithCurrent = MODEL_OPTIONS.some((o) => o.id === currentModel)
    ? MODEL_OPTIONS
    : [{ id: currentModel, label: `${currentModel} (custom)` }, ...MODEL_OPTIONS];

  const modelDropdown = (
    <section className="modal-section">
      <h3>Model</h3>
      <p className="muted">
        Used for chat, Deep Plan, and Deep Search.
      </p>
      <div className="row">
        <select
          className="model-select"
          value={currentModel}
          onChange={(e) => void changeModel(e.target.value)}
          disabled={saving}
        >
          {optionsWithCurrent.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );

  return (
    <div className="modal-backdrop" onClick={closeSettings}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Settings</h2>
          <button type="button" className="link" onClick={closeSettings}>
            Close
          </button>
        </header>

        {USE_OPENMYST ? (
          <>
            <AccountSection />
            {modelDropdown}
          </>
        ) : (
          <>
            <section className="modal-section">
              <h3>OpenRouter API key</h3>
              <p className="muted">
                Stored encrypted via your OS keychain. Get a key at openrouter.ai.
              </p>
              {settings?.hasOpenRouterKey ? (
                <div className="row">
                  <span className="status-ok">Key is set</span>
                  <button type="button" onClick={() => void clearKey()} disabled={saving}>
                    Clear key
                  </button>
                </div>
              ) : (
                <div className="row">
                  <input
                    type="password"
                    placeholder="sk-or-..."
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveKey()}
                    disabled={saving || key.trim().length === 0}
                  >
                    Save key
                  </button>
                </div>
              )}
            </section>

            {modelDropdown}

            <section className="modal-section">
              <h3>Jina API key</h3>
              <p className="muted">
                Used by Deep Plan's research loop to search the web and scrape pages in one call.
                Stored encrypted via your OS keychain. Get a key at jina.ai.
              </p>
              {settings?.hasJinaKey ? (
                <div className="row">
                  <span className="status-ok">Key is set</span>
                  <button type="button" onClick={() => void clearJinaKey()} disabled={saving}>
                    Clear key
                  </button>
                </div>
              ) : (
                <div className="row">
                  <input
                    type="password"
                    placeholder="jina_..."
                    value={jinaKey}
                    onChange={(e) => setJinaKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveJinaKey()}
                    disabled={saving || jinaKey.trim().length === 0}
                  >
                    Save key
                  </button>
                </div>
              )}
            </section>

          </>
        )}

        {localError && <div className="error">{localError}</div>}

        <UpdatesSection />

        <section className="modal-section">
          <h3>Report a bug</h3>
          <p className="muted">
            Found something broken? Opens a pre-filled GitHub issue with your recent
            session logs attached. You review and post — nothing is sent automatically.
          </p>
          <div className="row">
            <button type="button" onClick={() => setShowBugReport(true)}>
              Report a bug
            </button>
          </div>
        </section>
      </div>

      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} />}
    </div>
  );
}

function UpdatesSection(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
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

  const check = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await bridge.updater.check();
      setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    setBusy(true);
    try {
      await bridge.updater.downloadAndInstall();
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <section className="modal-section">
        <h3>Updates</h3>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const { state, currentVersion, availableVersion, progressPercent, error } = status;

  let detail: string;
  if (state === 'disabled') {
    detail = 'Auto-update is only active in the packaged app.';
  } else if (state === 'idle') {
    detail = 'Click to check for a newer version.';
  } else if (state === 'checking') {
    detail = 'Checking for updates…';
  } else if (state === 'not-available') {
    detail = "You're on the latest version.";
  } else if (state === 'downloading') {
    detail =
      availableVersion != null
        ? `Downloading v${availableVersion}${progressPercent != null ? ` — ${progressPercent}%` : '…'}`
        : 'Downloading update…';
  } else if (state === 'downloaded') {
    detail =
      availableVersion != null
        ? `v${availableVersion} is ready. Restart to install.`
        : 'Update ready. Restart to install.';
  } else if (state === 'error') {
    detail = error ?? 'Something went wrong checking for updates.';
  } else if (state === 'available') {
    detail = availableVersion != null ? `v${availableVersion} is available.` : 'Update available.';
  } else {
    detail = '';
  }

  const checkDisabled = busy || state === 'checking' || state === 'downloading' || state === 'disabled';
  const showRestart = state === 'downloaded';

  return (
    <section className="modal-section">
      <h3>Updates</h3>
      <p className="muted">
        Current version: <strong>{currentVersion}</strong>
      </p>
      <p className="muted">{detail}</p>
      <div className="row">
        <button type="button" onClick={() => void check()} disabled={checkDisabled}>
          Check for updates
        </button>
        {showRestart && (
          <button
            type="button"
            className="primary"
            onClick={() => void install()}
            disabled={busy}
          >
            Restart & install
          </button>
        )}
      </div>
    </section>
  );
}

function AccountSection(): JSX.Element {
  const { snapshot, offline } = useMe();
  const { signOut, loading: signingOut } = useAuth();

  const handleSignOut = async (): Promise<void> => {
    await signOut();
  };

  const openDashboard = (): void => {
    window.open('https://www.openmyst.ai/dashboard', '_blank', 'noreferrer');
  };

  return (
    <>
      <section className="modal-section">
        <h3>Account</h3>
        {snapshot ? (
          <>
            <p className="muted">
              Signed in as <strong>{snapshot.user.email || snapshot.user.id}</strong>
              {snapshot.plan && <> · plan: <strong>{snapshot.plan}</strong></>}
              {offline && <> · <em>offline</em></>}
            </p>
            <div className="row">
              <button type="button" onClick={openDashboard}>
                Manage on web
              </button>
              <button type="button" onClick={() => void handleSignOut()} disabled={signingOut}>
                Sign out
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Signing in…</p>
        )}
      </section>

      {snapshot && (
        <section className="modal-section">
          <h3>Daily usage</h3>
          <ul className="quota-list">
            <li>
              Chat tokens:{' '}
              {snapshot.quota.chat.limit === null
                ? `${formatTokens(snapshot.quota.chat.used)} (unlimited)`
                : `${formatTokens(snapshot.quota.chat.used)} / ${formatTokens(snapshot.quota.chat.limit)}`}
            </li>
            <li>
              Search tokens:{' '}
              {snapshot.quota.search.limit === null
                ? `${formatTokens(snapshot.quota.search.used)} (unlimited)`
                : `${formatTokens(snapshot.quota.search.used)} / ${formatTokens(snapshot.quota.search.limit)}`}
            </li>
          </ul>
        </section>
      )}
    </>
  );
}
