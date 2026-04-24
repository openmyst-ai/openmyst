import { useEffect, useMemo, useState } from 'react';
import type { UpdateStatus, WorkspaceProject } from '@shared/types';
import { useApp } from '../store/app';
import { useAuth } from '../store/auth';
import { bridge } from '../api/bridge';
import logoUrl from '../assets/logo.svg';

/**
 * First screen the user ever sees. Two modes:
 *   1. Workspace not set → hero with spinning logo + "start" action.
 *   2. Workspace set → project gallery with scrollable cards.
 *
 * Settings lives in a fixed corner so it never crowds the card layout.
 * The native file-dialog entry points stay as escape hatches.
 */
type WelcomeView = 'home' | 'projects';

export function Welcome(): JSX.Element {
  const { settings, openSettings } = useApp();
  const hasWorkspace = Boolean(settings?.workspaceRoot);
  // Default signed-in landing is the Home screen. From there the user
  // chooses whether to enter the project gallery. Workspace-not-set is
  // still a separate branch — can't show Home without a workspace to
  // own the projects.
  const [view, setView] = useState<WelcomeView>('home');

  return (
    <div className="welcome welcome-v2">
      <button
        type="button"
        className="welcome-corner-btn"
        onClick={openSettings}
        title="Settings"
      >
        Settings
      </button>
      <div className="welcome-stage">
        {!hasWorkspace ? (
          <WorkspaceSetup />
        ) : view === 'home' ? (
          <HomeView onOpenProjects={() => setView('projects')} />
        ) : (
          <ProjectGallery onBackToHome={() => setView('home')} />
        )}
      </div>
    </div>
  );
}

function SpinningLogo(props: { size: number }): JSX.Element {
  return (
    <img
      src={logoUrl}
      className="welcome-logo app-logo"
      style={{ width: props.size, height: props.size }}
      alt=""
      aria-hidden="true"
    />
  );
}

/**
 * Post-login landing screen. Shows app identity + version + the three
 * actions a freshly-logged-in user reaches for: enter their project
 * gallery, check for an update, sign out. Settings is already on the
 * Welcome shell (corner button), so it isn't repeated here.
 */
function HomeView({ onOpenProjects }: { onOpenProjects: () => void }): JSX.Element {
  const { signOut } = useAuth();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
    setChecking(true);
    try {
      const next = await bridge.updater.check();
      setStatus(next);
    } finally {
      setChecking(false);
    }
  };

  const install = async (): Promise<void> => {
    try {
      await bridge.updater.downloadAndInstall();
    } catch (err) {
      console.error(err);
    }
  };

  const handleSignOut = async (): Promise<void> => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  const currentVersion = status?.currentVersion ?? '—';
  const updateState = status?.state ?? 'idle';

  // Update status line phrased for the home screen (Settings has its own
  // fuller copy). We only surface the useful states here: checking,
  // available, downloading, downloaded-ready, not-available, error.
  let updateLine: string | null = null;
  if (updateState === 'checking' || checking) {
    updateLine = 'Checking…';
  } else if (updateState === 'available') {
    updateLine = status?.availableVersion
      ? `Update available: v${status.availableVersion}`
      : 'Update available';
  } else if (updateState === 'downloading') {
    updateLine = status?.progressPercent != null
      ? `Downloading… ${status.progressPercent}%`
      : 'Downloading…';
  } else if (updateState === 'downloaded') {
    updateLine = status?.availableVersion
      ? `v${status.availableVersion} ready — restart to install`
      : 'Update ready';
  } else if (updateState === 'not-available') {
    updateLine = 'You\'re on the latest version.';
  } else if (updateState === 'error') {
    updateLine = status?.error ?? 'Update check failed.';
  }

  const showRestart = updateState === 'downloaded';
  const checkDisabled =
    checking || updateState === 'checking' || updateState === 'downloading' || updateState === 'disabled';

  return (
    <div className="welcome-hero welcome-home">
      <SpinningLogo size={120} />
      <h1 className="welcome-title">Open Myst</h1>
      <p className="welcome-tagline">Your grounded research collaborator.</p>
      <p className="welcome-lede">
        Every claim traces back to a verbatim source. A panel of agents
        helps you think it through. You steer the vision; Myst keeps the
        evidence honest.
      </p>

      <div className="welcome-home-actions">
        <button
          type="button"
          className="welcome-bubble welcome-bubble-primary welcome-bubble-lg"
          onClick={onOpenProjects}
        >
          Go to my projects →
        </button>

        <div className="welcome-home-secondary">
          <button
            type="button"
            className="welcome-bubble welcome-bubble-ghost"
            onClick={() => void check()}
            disabled={checkDisabled}
          >
            Check for updates
          </button>
          {showRestart && (
            <button
              type="button"
              className="welcome-bubble"
              onClick={() => void install()}
            >
              Restart &amp; install
            </button>
          )}
          <button
            type="button"
            className="welcome-bubble welcome-bubble-ghost"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>

        <p className="welcome-home-footnote muted">
          v{currentVersion}
          {updateLine ? <> · {updateLine}</> : null}
        </p>
      </div>
    </div>
  );
}

function WorkspaceSetup(): JSX.Element {
  const {
    settings,
    setWorkspaceRoot,
    pickWorkspaceRoot,
    loading,
    error,
    dismissError,
  } = useApp();
  const suggested = settings?.defaultWorkspaceRoot ?? '';

  return (
    <div className="welcome-hero">
      <SpinningLogo size={140} />
      <h1 className="welcome-title">Open Myst</h1>
      <p className="welcome-subtitle">A writing and research companion.</p>

      <p className="welcome-lead">Choose a folder to keep all your projects in.</p>

      <div className="welcome-path-chip" title={suggested}>
        <span className="welcome-path-chip-icon" aria-hidden="true">📁</span>
        <span className="welcome-path-chip-text">{suggested || '—'}</span>
      </div>

      <div className="welcome-bubble-row">
        <button
          type="button"
          className="welcome-bubble welcome-bubble-primary"
          onClick={() => void setWorkspaceRoot(suggested)}
          disabled={loading || !suggested}
        >
          Use this folder
        </button>
        <button
          type="button"
          className="welcome-bubble"
          onClick={() => void pickWorkspaceRoot()}
          disabled={loading}
        >
          Choose another…
        </button>
      </div>

      <p className="welcome-fineprint">You can change this later in Settings.</p>

      {error && (
        <div className="welcome-error" onClick={dismissError}>
          {error}
        </div>
      )}
    </div>
  );
}

function ProjectGallery({ onBackToHome }: { onBackToHome: () => void }): JSX.Element {
  const {
    settings,
    workspaceProjects,
    workspaceLoading,
    refreshWorkspaceProjects,
    openProjectByPath,
    openExistingProject,
    pickWorkspaceRoot,
    loading,
    error,
    dismissError,
  } = useApp();
  const [showNewProject, setShowNewProject] = useState(false);
  const workspaceRoot = settings?.workspaceRoot ?? '';

  useEffect(() => {
    void refreshWorkspaceProjects();
  }, [refreshWorkspaceProjects]);

  return (
    <>
      <div className="welcome-gallery-v2">
        <header className="welcome-gallery-hero">
          <SpinningLogo size={64} />
          <div className="welcome-gallery-hero-text">
            <h1 className="welcome-title-sm">Open Myst</h1>
            <p className="welcome-gallery-root" title={workspaceRoot}>
              {workspaceRoot}
            </p>
          </div>
          <button
            type="button"
            className="welcome-bubble welcome-bubble-primary welcome-bubble-lg"
            onClick={() => setShowNewProject(true)}
            disabled={loading}
          >
            + New project
          </button>
        </header>

        <div className="welcome-gallery-body">
          {workspaceLoading && workspaceProjects.length === 0 ? (
            <div className="welcome-gallery-empty muted">Loading projects…</div>
          ) : workspaceProjects.length === 0 ? (
            <div className="welcome-gallery-empty">
              <p className="welcome-empty-title">No projects yet.</p>
              <p className="muted">Create your first one to get started.</p>
              <button
                type="button"
                className="welcome-bubble welcome-bubble-primary"
                onClick={() => setShowNewProject(true)}
              >
                + New project
              </button>
            </div>
          ) : (
            <div className="welcome-gallery-list">
              {workspaceProjects.map((p) => (
                <ProjectCard
                  key={p.path}
                  project={p}
                  onOpen={() => void openProjectByPath(p.path)}
                  disabled={loading}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="welcome-gallery-footer">
          <button
            type="button"
            className="welcome-bubble welcome-bubble-ghost"
            onClick={onBackToHome}
          >
            ← Home
          </button>
          <div className="welcome-gallery-footer-right">
            <button
              type="button"
              className="welcome-bubble welcome-bubble-ghost"
              onClick={() => void openExistingProject()}
              disabled={loading}
            >
              Open from disk…
            </button>
            <button
              type="button"
              className="welcome-bubble welcome-bubble-ghost"
              onClick={() => void pickWorkspaceRoot()}
              disabled={loading}
            >
              Change workspace folder
            </button>
          </div>
        </footer>

        {error && (
          <div className="welcome-error" onClick={dismissError}>
            {error}
          </div>
        )}
      </div>

      {showNewProject && (
        <NewProjectModal onClose={() => setShowNewProject(false)} />
      )}
    </>
  );
}

function ProjectCard(props: {
  project: WorkspaceProject;
  onOpen: () => void;
  disabled: boolean;
}): JSX.Element {
  const { project, onOpen, disabled } = props;
  const date = useMemo(() => formatDate(project.updatedAt), [project.updatedAt]);
  const initial = project.name.charAt(0).toUpperCase() || '·';

  return (
    <button
      type="button"
      className="welcome-project-card-v2"
      onClick={onOpen}
      disabled={disabled}
    >
      <div className="welcome-project-avatar" aria-hidden="true">
        {initial}
      </div>
      <div className="welcome-project-body">
        <div className="welcome-project-name">{project.name}</div>
        <div className="welcome-project-path" title={project.path}>
          {project.path}
        </div>
      </div>
      {date && <div className="welcome-project-date">{date}</div>}
    </button>
  );
}

function NewProjectModal(props: { onClose: () => void }): JSX.Element {
  const { settings, createProjectByName, loading, error, dismissError } = useApp();
  const [name, setName] = useState('');
  const [parentOverride, setParentOverride] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const sanitized = sanitizePreview(name);
  const parentDir = parentOverride ?? settings?.workspaceRoot ?? '';
  const previewPath = sanitized ? joinPath(parentDir, sanitized) : '';

  const canCreate = sanitized.length > 0 && !loading;

  const submit = async (): Promise<void> => {
    if (!canCreate) return;
    dismissError();
    await createProjectByName({
      name,
      parentDir: parentOverride ?? undefined,
    });
  };

  const pickCustomParent = async (): Promise<void> => {
    const picked = await window.myst?.workspace.pickRoot();
    if (picked) {
      setParentOverride(picked);
    }
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal welcome-new-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>New project</h2>
          <button type="button" className="link" onClick={props.onClose}>
            Close
          </button>
        </header>

        <label className="welcome-field-label" htmlFor="new-project-name">
          Project name
        </label>
        <input
          id="new-project-name"
          autoFocus
          type="text"
          value={name}
          placeholder="My research project"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          className="welcome-field-input"
        />
        {previewPath && (
          <div className="welcome-path-chip welcome-path-chip-sm" title={previewPath}>
            <span className="welcome-path-chip-icon" aria-hidden="true">📁</span>
            <span className="welcome-path-chip-text">{previewPath}</span>
          </div>
        )}

        <button
          type="button"
          className="welcome-disclosure"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          {advancedOpen ? '▾' : '▸'} Advanced: custom location
        </button>
        {advancedOpen && (
          <div className="welcome-advanced-v2">
            <p className="muted">
              Put the project anywhere on disk instead of inside your workspace folder.
            </p>
            <div className="row">
              <input
                type="text"
                value={parentOverride ?? ''}
                placeholder={settings?.workspaceRoot ?? 'Choose a location…'}
                onChange={(e) => setParentOverride(e.target.value || null)}
                className="welcome-field-input"
              />
              <button
                type="button"
                className="welcome-bubble welcome-bubble-sm"
                onClick={() => void pickCustomParent()}
              >
                Browse…
              </button>
            </div>
            {parentOverride && (
              <button
                type="button"
                className="link"
                onClick={() => setParentOverride(null)}
              >
                Reset to workspace folder
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="welcome-error" onClick={dismissError}>
            {error}
          </div>
        )}

        <div className="welcome-modal-actions">
          <button
            type="button"
            className="welcome-bubble welcome-bubble-ghost"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="welcome-bubble welcome-bubble-primary"
            onClick={() => void submit()}
            disabled={!canCreate}
          >
            Create project
          </button>
        </div>
      </div>
    </div>
  );
}

function sanitizePreview(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
}

function joinPath(parent: string, child: string): string {
  if (!parent) return child;
  const sep = parent.includes('\\') ? '\\' : '/';
  const trimmed = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return `${trimmed}${sep}${child}`;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return d.toLocaleDateString();
}
