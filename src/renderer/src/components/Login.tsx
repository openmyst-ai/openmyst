import { useState } from 'react';
import logoUrl from '../assets/logo.svg';
import { useAuth } from '../store/auth';

export function Login(): JSX.Element {
  const { signIn, pasteToken, loading, error, dismissError } = useAuth();
  const [showPaste, setShowPaste] = useState(false);
  const [token, setToken] = useState('');

  const onPaste = async (): Promise<void> => {
    if (!token.trim()) return;
    await pasteToken(token.trim());
    setToken('');
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="login-header">
          <img src={logoUrl} className="app-logo login-logo" alt="" aria-hidden="true" />
          <h1>Open Myst</h1>
        </div>
        <p className="welcome-tagline">Sign in to start writing and researching.</p>

        <div className="welcome-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void signIn()}
            disabled={loading}
          >
            Sign in with browser
          </button>
          <button
            type="button"
            onClick={() => setShowPaste((v) => !v)}
            disabled={loading}
          >
            {showPaste ? 'Hide' : 'I have a token'}
          </button>
        </div>

        {showPaste && (
          <div className="login-paste">
            <p className="muted">
              Copy the token from the login page and paste it below. We'll store it
              securely in your OS keychain.
            </p>
            <div className="row">
              <input
                type="password"
                placeholder="omk_live_..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="primary"
                onClick={() => void onPaste()}
                disabled={loading || token.trim().length === 0}
              >
                Use token
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button type="button" className="link" onClick={dismissError}>
              Dismiss
            </button>
          </div>
        )}

        <div className="welcome-footer">
          <span className="hint">
            After signing in on the web, your browser will hand the session back to
            this app automatically. If it doesn't, click "I have a token" above.
          </span>
        </div>
      </div>
    </div>
  );
}
