import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCurrentProject } from '../features/projects';

/**
 * Project-scoped filesystem helpers. Every piece of main-process code that
 * touches a project file goes through here — so there's one place that knows
 * how to resolve "a path inside the currently open project", and one place
 * that defines what "project is open" means.
 *
 * Rule of thumb: if you find yourself typing `getCurrentProject()` or
 * `join(project.path, …)` in a feature file, you probably want one of these
 * helpers instead.
 */

export function projectRoot(): string {
  const project = getCurrentProject();
  if (!project) throw new Error('No project is open.');
  return project.path;
}

export function projectPath(...segments: string[]): string {
  return join(projectRoot(), ...segments);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Read a project-relative file. Returns '' for ENOENT so callers can treat
 * "missing" and "empty" identically — matches how every feature was already
 * handling it before this extraction.
 */
export async function readProjectFile(relativePath: string): Promise<string> {
  try {
    return await fs.readFile(projectPath(relativePath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function writeProjectFile(relativePath: string, content: string): Promise<void> {
  await fs.writeFile(projectPath(relativePath), content, 'utf-8');
}

/** Atomic write: write to a unique tmp then rename. Concurrent calls can't
 *  race on a shared tmp path. */
export async function writeProjectFileAtomic(relativePath: string, content: string): Promise<void> {
  const target = projectPath(relativePath);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, target);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* orphan cleanup best-effort */
    }
    throw err;
  }
}
