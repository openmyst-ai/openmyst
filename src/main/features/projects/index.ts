import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectMeta, Result } from '@shared/types';
import { pushRecentProject } from '../settings';
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
