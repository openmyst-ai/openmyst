import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import type { ProjectMeta, Result, WorkspaceProject } from '@shared/types';
import { getWorkspaceRoot, pushRecentProject, setWorkspaceRoot } from '../settings';
import agentTemplate from './agent-template.md?raw';

/**
 * Project lifecycle: create, open, track the currently-open project, and
 * scaffold the on-disk folder layout.
 *
 * Every project is a plain directory the user picks. We own a small set of
 * files + folders inside it — see docs/data-model.md for the full layout.
 * `.myst/` holds machine-managed state (comments, pending edits, wiki);
 * everything outside it is user-facing and git-friendly.
 *
 * The agent's system prompt lives in `agent.md` inside each project, seeded
 * from `agent-template.md` in this folder (imported via Vite `?raw`). Users
 * can edit the seeded copy per-project.
 */

const AGENT_TEMPLATE = agentTemplate;

let currentProject: ProjectMeta | null = null;

function projectJsonPath(root: string): string {
  return join(root, 'project.json');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Older projects (pre-multi-doc) had a single `document.md` at the project
 * root. We migrate that into `documents/<name>.md` on open so old folders
 * keep working. Also mkdirs `.myst/wiki/` for projects created before Phase 5.
 */
async function migrateToDocumentsFolder(root: string, name: string): Promise<void> {
  const oldDoc = join(root, 'document.md');
  const docsDir = join(root, 'documents');

  if (!(await pathExists(docsDir))) {
    await fs.mkdir(docsDir, { recursive: true });
  }

  if (await pathExists(oldDoc)) {
    const target = join(docsDir, `${name}.md`);
    if (!(await pathExists(target))) {
      await fs.rename(oldDoc, target);
    }
  }

  await fs.mkdir(join(root, '.myst', 'wiki'), { recursive: true });
}

async function scaffoldProject(root: string, name: string): Promise<ProjectMeta> {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(join(root, 'documents'), { recursive: true });
  await fs.mkdir(join(root, 'sources'), { recursive: true });
  await fs.mkdir(join(root, '.myst', 'diffs'), { recursive: true });
  await fs.mkdir(join(root, '.myst', 'comments'), { recursive: true });
  await fs.mkdir(join(root, '.myst', 'pending'), { recursive: true });
  await fs.mkdir(join(root, '.myst', 'wiki'), { recursive: true });
  await fs.mkdir(join(root, '.myst', 'deep-plan'), { recursive: true });

  const meta: ProjectMeta = {
    name,
    path: root,
    defaultModel: null,
    createdAt: new Date().toISOString(),
  };

  const writes: Array<[string, string]> = [
    [projectJsonPath(root), JSON.stringify(meta, null, 2)],
    [join(root, 'agent.md'), AGENT_TEMPLATE],
    [join(root, 'documents', `${name}.md`), `# ${name}\n`],
    [join(root, 'chat.jsonl'), ''],
    [join(root, 'comments.json'), '[]'],
    [join(root, 'sources', 'index.md'), '# Sources\n\n_No sources yet._\n'],
  ];

  for (const [path, contents] of writes) {
    if (!(await pathExists(path))) {
      await fs.writeFile(path, contents, 'utf-8');
    }
  }

  return meta;
}

async function readProject(root: string): Promise<ProjectMeta> {
  const raw = await fs.readFile(projectJsonPath(root), 'utf-8');
  return JSON.parse(raw) as ProjectMeta;
}

export async function createNewProject(): Promise<Result<ProjectMeta>> {
  const result = await dialog.showOpenDialog({
    title: 'Choose a folder for your new Open Myst project',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Create project here',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'cancelled' };
  }
  const root = result.filePaths[0]!;
  const name = basename(root);
  const meta = await scaffoldProject(root, name);
  currentProject = meta;
  await pushRecentProject(root);
  // Brand-new projects drop the user into Deep Plan mode on first load.
  // We write a marker file directly to avoid a circular import with the
  // deepPlan feature; it's cleared on skip/handoff from inside that feature.
  await fs.writeFile(
    join(root, '.myst', 'deep-plan', 'pending.flag'),
    new Date().toISOString(),
    'utf-8',
  );
  return { ok: true, value: meta };
}

export async function openProject(): Promise<Result<ProjectMeta>> {
  const result = await dialog.showOpenDialog({
    title: 'Open an Open Myst project',
    properties: ['openDirectory'],
    buttonLabel: 'Open project',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, error: 'cancelled' };
  }
  const root = result.filePaths[0]!;
  if (!(await pathExists(projectJsonPath(root)))) {
    return {
      ok: false,
      error: 'Not an Open Myst project (no project.json found). Create a new project instead.',
    };
  }
  const meta = await readProject(root);
  currentProject = meta;
  await pushRecentProject(root);
  await migrateToDocumentsFolder(root, meta.name);
  return { ok: true, value: meta };
}

export function getCurrentProject(): ProjectMeta | null {
  return currentProject;
}

export function closeProject(): void {
  currentProject = null;
}

/**
 * Sanitize a user-typed project name into something safe to use as a folder
 * name. Strips path separators, trims whitespace, collapses repeats. The
 * UI shows the resulting path before creation so the user can see what
 * they'll get.
 */
export function sanitizeProjectName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
}

/**
 * Pick a workspace root via the native folder dialog. Persists to settings
 * and creates the directory if it doesn't exist. Returns the resolved path
 * or `null` on cancel.
 */
export async function pickWorkspaceRoot(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose where to keep your Open Myst projects',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const root = result.filePaths[0]!;
  await fs.mkdir(root, { recursive: true });
  await setWorkspaceRoot(root);
  return root;
}

/**
 * Persist the workspace root to a path the renderer already has (e.g. the
 * default suggestion the user accepted without browsing). Creates the
 * folder if needed.
 */
export async function ensureWorkspaceRoot(path: string): Promise<string> {
  const resolved = resolvePath(path);
  await fs.mkdir(resolved, { recursive: true });
  await setWorkspaceRoot(resolved);
  return resolved;
}

/**
 * Scan the workspace root for project directories and return a summary
 * for each. Quietly skips folders without a `project.json` so users can
 * keep unrelated stuff in the same folder without it showing up.
 */
export async function listWorkspaceProjects(): Promise<WorkspaceProject[]> {
  const root = await getWorkspaceRoot();
  if (!root) return [];
  if (!(await pathExists(root))) return [];

  const entries = await fs.readdir(root, { withFileTypes: true });
  const out: WorkspaceProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const projectPath = join(root, entry.name);
    const metaPath = projectJsonPath(projectPath);
    if (!(await pathExists(metaPath))) continue;

    let name = entry.name;
    let createdAt = '';
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Partial<ProjectMeta>;
      if (typeof meta.name === 'string' && meta.name.length > 0) name = meta.name;
      if (typeof meta.createdAt === 'string') createdAt = meta.createdAt;
    } catch {
      /* fall through with folder-derived defaults */
    }

    let updatedAt = createdAt;
    try {
      const stat = await fs.stat(projectPath);
      const mtime = stat.mtime.toISOString();
      updatedAt = mtime;
      if (!createdAt) createdAt = stat.birthtime?.toISOString?.() || mtime;
    } catch {
      /* nothing actionable */
    }

    out.push({ name, path: projectPath, createdAt, updatedAt });
  }

  // Most recently touched first — cheap proxy for "last opened".
  out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  return out;
}

/**
 * Create a new project under the workspace root, using `name` as both the
 * project name and the folder basename. Caller can override the parent dir
 * via `parentDir` for the "advanced: choose custom location" escape hatch.
 *
 * Refuses to overwrite an existing folder — the UI is expected to surface
 * the conflict and prompt for a different name.
 */
export async function createProjectByName(input: {
  name: string;
  parentDir?: string;
}): Promise<Result<ProjectMeta>> {
  const cleanedName = sanitizeProjectName(input.name);
  if (!cleanedName) {
    return { ok: false, error: 'Please enter a project name.' };
  }

  let parent = input.parentDir ?? (await getWorkspaceRoot());
  if (!parent) {
    return { ok: false, error: 'Workspace folder is not set yet.' };
  }
  parent = resolvePath(parent);
  await fs.mkdir(parent, { recursive: true });

  const root = join(parent, cleanedName);
  if (await pathExists(root)) {
    return {
      ok: false,
      error: `A folder named "${cleanedName}" already exists in this location.`,
    };
  }

  const meta = await scaffoldProject(root, cleanedName);
  currentProject = meta;
  await pushRecentProject(root);
  await fs.writeFile(
    join(root, '.myst', 'deep-plan', 'pending.flag'),
    new Date().toISOString(),
    'utf-8',
  );
  return { ok: true, value: meta };
}

/**
 * Open a project by an explicit path (used when the user clicks one in the
 * gallery). Same validation + migration as the dialog-based `openProject`,
 * minus the dialog itself.
 */
export async function openProjectByPath(path: string): Promise<Result<ProjectMeta>> {
  const root = resolvePath(path);
  if (!(await pathExists(projectJsonPath(root)))) {
    return {
      ok: false,
      error: 'That folder does not contain an Open Myst project.',
    };
  }
  const meta = await readProject(root);
  currentProject = meta;
  await pushRecentProject(root);
  await migrateToDocumentsFolder(root, meta.name);
  return { ok: true, value: meta };
}
