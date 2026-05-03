import logoUrl from '../assets/logo.svg';
import { useAuth } from '../store/auth';

export function Login(): JSX.Element {
  const { signIn, loading, error, dismissError } = useAuth();

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
        </div>

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
            this app automatically.
          </span>
        </div>
      </div>
    </div>
  );
}
