import { useEffect } from 'react';
import { USE_OPENMYST } from '@shared/flags';
import { useApp } from './store/app';
import { useAuth } from './store/auth';
import { useMe } from './store/me';
import { useDeepPlan } from './store/deepPlan';
import { Layout } from './components/Layout';
import { Welcome } from './components/Welcome';
import { Login } from './components/Login';
import { SettingsModal } from './components/SettingsModal';
import { DeepPlanMode } from './components/DeepPlanMode';
import { UpdateAvailableModal } from './components/UpdateAvailableModal';

export function App(): JSX.Element {
  const { project, settingsOpen, init, error, dismissError } = useApp();
  const { signedIn, init: initAuth } = useAuth();
  const { init: initMe } = useMe();
  const { visible: deepPlanVisible, refresh: refreshDeepPlan } = useDeepPlan();

  useEffect(() => {
    void initAuth();
    void initMe();
  }, [initAuth, initMe]);

  useEffect(() => {
    // In managed mode, only load app-level state after the user is signed in
    // — otherwise `projects.getCurrent` fires before the token is available
    // and we'd show a stale last-project screen behind the login.
    if (USE_OPENMYST && !signedIn) return;
    void init();
  }, [init, signedIn]);

  // Whenever a project becomes current, ask main if Deep Plan should auto-open.
  useEffect(() => {
    if (project) {
      void refreshDeepPlan();
    }
  }, [project, refreshDeepPlan]);

  // Managed-mode auth gate. Strips out under BYOK dev builds via the
  // compile-time literal so the Login component never renders.
  if (USE_OPENMYST && !signedIn) {
    return (
      <div className="app-root">
        <Login />
      </div>
    );
  }

  return (
    <div className="app-root">
      {project ? (
        deepPlanVisible ? (
          <DeepPlanMode />
        ) : (
          <Layout />
        )
      ) : (
        <Welcome />
      )}
      {settingsOpen && <SettingsModal />}
      <UpdateAvailableModal />
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button type="button" className="link" onClick={dismissError}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
