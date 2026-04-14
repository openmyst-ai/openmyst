import { useEffect } from 'react';
import { useApp } from './store/app';
import { useDeepPlan } from './store/deepPlan';
import { Layout } from './components/Layout';
import { Welcome } from './components/Welcome';
import { SettingsModal } from './components/SettingsModal';
import { DeepPlanMode } from './components/DeepPlanMode';

export function App(): JSX.Element {
  const { project, settingsOpen, init, error, dismissError } = useApp();
  const { visible: deepPlanVisible, refresh: refreshDeepPlan } = useDeepPlan();

  useEffect(() => {
    void init();
  }, [init]);

  // Whenever a project becomes current, ask main if Deep Plan should auto-open.
  useEffect(() => {
    if (project) {
      void refreshDeepPlan();
    }
  }, [project, refreshDeepPlan]);

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
