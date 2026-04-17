import { useEffect, useState } from 'react';
import { USE_OPENMYST } from '@shared/flags';
import { useApp } from '../store/app';
import { useAuth } from '../store/auth';
import { useMe } from '../store/me';
import { bridge } from '../api/bridge';
import { BugReportModal } from './BugReportModal';

export function SettingsModal(): JSX.Element {
  const { settings, closeSettings, refreshSettings } = useApp();
  const [key, setKey] = useState('');
  const [jinaKey, setJinaKey] = useState('');
  const [model, setModel] = useState(settings?.defaultModel ?? '');
  const [deepPlanModel, setDeepPlanModel] = useState(settings?.deepPlanModel ?? '');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showBugReport, setShowBugReport] = useState(false);

  useEffect(() => {
    if (settings) {
      setModel(settings.defaultModel);
      setDeepPlanModel(settings.deepPlanModel);
    }
  }, [settings]);

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

  const saveModel = async (): Promise<void> => {
    setLocalError(null);
    setSaving(true);
    try {
      await bridge.settings.setDefaultModel(model);
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

  const saveDeepPlanModel = async (): Promise<void> => {
    setLocalError(null);
    setSaving(true);
    try {
      await bridge.settings.setDeepPlanModel(deepPlanModel);
      await refreshSettings();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

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
          <AccountSection />
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

            <section className="modal-section">
              <h3>Default model</h3>
              <p className="muted">OpenRouter model id used unless a project overrides it.</p>
              <div className="row">
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="google/gemma-3-27b-it"
                />
                <button type="button" onClick={() => void saveModel()} disabled={saving}>
                  Save model
                </button>
              </div>
            </section>

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

            <section className="modal-section">
              <h3>Deep Plan model</h3>
              <p className="muted">
                OpenRouter model used by Deep Plan's planner and one-shot generator. Defaults to an
                open-source model to keep the research loop cheap.
              </p>
              <div className="row">
                <input
                  type="text"
                  value={deepPlanModel}
                  onChange={(e) => setDeepPlanModel(e.target.value)}
                  placeholder="deepseek/deepseek-chat"
                />
                <button type="button" onClick={() => void saveDeepPlanModel()} disabled={saving}>
                  Save model
                </button>
              </div>
            </section>
          </>
        )}

        {localError && <div className="error">{localError}</div>}

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
              Chat:{' '}
              {snapshot.quota.chat.limit === null
                ? `${snapshot.quota.chat.used} (unlimited)`
                : `${snapshot.quota.chat.used} / ${snapshot.quota.chat.limit}`}
            </li>
            <li>
              Search:{' '}
              {snapshot.quota.search.limit === null
                ? `${snapshot.quota.search.used} (unlimited)`
                : `${snapshot.quota.search.used} / ${snapshot.quota.search.limit}`}
            </li>
          </ul>
        </section>
      )}
    </>
  );
}
