import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceProject } from '@shared/types';
import { useApp } from '../store/app';

/**
 * Three-mode landing surface:
 *   1. Workspace not set → pick a folder where all projects live.
 *   2. Workspace set → scrollable gallery of existing projects + "New project".
 *   3. "New project" clicked → inline modal with just a name field (and an
 *      advanced disclosure for overriding the parent dir).
 *
 * The native file-dialog entry points are kept as escape hatches so users
 * with projects outside the workspace can still open them.
 */
export function Welcome(): JSX.Element {
  const { settings, openSettings } = useApp();
  const hasWorkspace = Boolean(settings?.workspaceRoot);

  return (
    <div className="welcome">
      <div className="welcome-shell">
        {hasWorkspace ? <ProjectGallery /> : <WorkspaceSetup />}
        <div className="welcome-shell-footer">
          <button type="button" className="link" onClick={openSettings}>
            Settings
          </button>
        </div>
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
    <div className="welcome-card welcome-setup">
      <h1>Welcome to Open Myst</h1>
      <p className="welcome-tagline">
        First, pick a folder to keep all your projects in. You can change this
        any time from Settings.
      </p>
      <div className="welcome-path-preview" title={suggested}>
        {suggested || '—'}
      </div>
      <div className="welcome-actions">
        <button
          type="button"
          className="primary"
          onClick={() => void setWorkspaceRoot(suggested)}
          disabled={loading || !suggested}
        >
          Use this folder
        </button>
        <button type="button" onClick={() => void pickWorkspaceRoot()} disabled={loading}>
          Choose a different folder…
        </button>
      </div>
      {error && (
        <div className="error" onClick={dismissError}>
          {error}
        </div>
      )}
    </div>
  );
}

function ProjectGallery(): JSX.Element {
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
      <div className="welcome-card welcome-gallery">
        <header className="welcome-gallery-header">
          <div>
            <h1>Your projects</h1>
            <p className="welcome-gallery-root" title={workspaceRoot}>
              {workspaceRoot}
            </p>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => setShowNewProject(true)}
            disabled={loading}
          >
            + New project
          </button>
        </header>

        <div className="welcome-gallery-list">
          {workspaceLoading && workspaceProjects.length === 0 ? (
            <div className="welcome-gallery-empty muted">Loading…</div>
          ) : workspaceProjects.length === 0 ? (
            <div className="welcome-gallery-empty">
              <p className="muted">No projects here yet.</p>
              <button
                type="button"
                className="primary"
                onClick={() => setShowNewProject(true)}
              >
                Create your first project
              </button>
            </div>
          ) : (
            workspaceProjects.map((p) => (
              <ProjectCard
                key={p.path}
                project={p}
                onOpen={() => void openProjectByPath(p.path)}
                disabled={loading}
              />
            ))
          )}
        </div>

        <footer className="welcome-gallery-actions">
          <button
            type="button"
            className="link"
            onClick={() => void openExistingProject()}
            disabled={loading}
          >
            Open from disk…
          </button>
          <button
            type="button"
            className="link"
            onClick={() => void pickWorkspaceRoot()}
            disabled={loading}
          >
            Change workspace folder
          </button>
        </footer>

        {error && (
          <div className="error" onClick={dismissError}>
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

  return (
    <button
      type="button"
      className="welcome-project-card"
      onClick={onOpen}
      disabled={disabled}
    >
      <div className="welcome-project-name">{project.name}</div>
      <div className="welcome-project-meta">
        <span className="muted" title={project.path}>
          {project.path}
        </span>
        {date && <span className="muted"> · {date}</span>}
      </div>
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>New project</h2>
          <button type="button" className="link" onClick={props.onClose}>
            Close
          </button>
        </header>

        <section className="modal-section">
          <label className="muted" htmlFor="new-project-name">
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
          />
          {previewPath && (
            <p className="muted welcome-path-preview-inline" title={previewPath}>
              Will be created at: <code>{previewPath}</code>
            </p>
          )}
        </section>

        <section className="modal-section">
          <button
            type="button"
            className="link"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? 'Hide' : 'Show'} advanced options
          </button>
          {advancedOpen && (
            <div className="welcome-advanced">
              <p className="muted">
                By default the project goes inside your workspace folder. Override
                to put it anywhere on disk.
              </p>
              <div className="row">
                <input
                  type="text"
                  value={parentOverride ?? ''}
                  placeholder={settings?.workspaceRoot ?? 'Choose a location…'}
                  onChange={(e) => setParentOverride(e.target.value || null)}
                />
                <button type="button" onClick={() => void pickCustomParent()}>
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
        </section>

        {error && (
          <div className="error" onClick={dismissError}>
            {error}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
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
