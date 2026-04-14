import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  DeepPlanRubric,
  DeepPlanSession,
  DeepPlanStage,
  DeepPlanStatus,
} from '@shared/types';
import { projectPath, projectRoot, ensureDir, log } from '../../platform';

/**
 * Deep Plan session state lives at `.myst/deep-plan/session.json`. There's
 * only ever one session per project — if the user wants to restart, we wipe
 * and create a new one. The auto-start flag (`pending.flag`) is a separate
 * marker file; its presence tells the renderer to drop straight into Deep
 * Plan when the project is freshly opened. It's removed on skip or handoff.
 */

function deepPlanDir(): string {
  return projectPath('.myst', 'deep-plan');
}

function sessionPath(): string {
  return projectPath('.myst', 'deep-plan', 'session.json');
}

function pendingFlagPath(): string {
  return projectPath('.myst', 'deep-plan', 'pending.flag');
}

function emptyRubric(): DeepPlanRubric {
  return {
    title: null,
    form: null,
    audience: null,
    lengthTarget: null,
    thesis: null,
    mustCover: [],
    mustAvoid: [],
    notes: '',
  };
}

export async function ensureDeepPlanDir(): Promise<void> {
  await ensureDir(deepPlanDir());
}

export async function markAutoStart(): Promise<void> {
  await ensureDeepPlanDir();
  await fs.writeFile(pendingFlagPath(), new Date().toISOString(), 'utf-8');
  log('deep-plan', 'autoStart.marked', {});
}

export async function clearAutoStart(): Promise<void> {
  try {
    await fs.unlink(pendingFlagPath());
    log('deep-plan', 'autoStart.cleared', {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export async function shouldAutoStart(): Promise<boolean> {
  try {
    await fs.access(pendingFlagPath());
    return true;
  } catch {
    return false;
  }
}

export async function readSession(): Promise<DeepPlanSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(), 'utf-8');
    return JSON.parse(raw) as DeepPlanSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeSession(session: DeepPlanSession): Promise<void> {
  await ensureDeepPlanDir();
  const next = { ...session, updatedAt: new Date().toISOString() };
  await fs.writeFile(sessionPath(), JSON.stringify(next, null, 2), 'utf-8');
}

export async function deleteSession(): Promise<void> {
  try {
    await fs.unlink(sessionPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export async function createSession(task: string): Promise<DeepPlanSession> {
  const root = projectRoot();
  const now = new Date().toISOString();
  const session: DeepPlanSession = {
    id: randomUUID(),
    projectPath: root,
    stage: 'intent',
    task: task.trim(),
    rubric: emptyRubric(),
    messages: [],
    researchQueries: [],
    tokensUsedK: 0,
    createdAt: now,
    updatedAt: now,
    skipped: false,
    completed: false,
  };
  await writeSession(session);
  log('deep-plan', 'session.created', { task: task.slice(0, 120) });
  return session;
}

export async function updateSession(
  patch: (session: DeepPlanSession) => DeepPlanSession,
): Promise<DeepPlanSession> {
  const existing = await readSession();
  if (!existing) throw new Error('No Deep Plan session is active.');
  const next = patch(existing);
  await writeSession(next);
  return next;
}

export function nextStage(stage: DeepPlanStage): DeepPlanStage {
  const order: DeepPlanStage[] = [
    'intent',
    'sources',
    'scoping',
    'gaps',
    'research',
    'clarify',
    'review',
    'handoff',
    'done',
  ];
  const i = order.indexOf(stage);
  if (i < 0 || i === order.length - 1) return 'done';
  return order[i + 1]!;
}

export async function buildStatus(): Promise<DeepPlanStatus> {
  const session = await readSession();
  const auto = await shouldAutoStart();
  return {
    active: session !== null && !session.completed && !session.skipped,
    shouldAutoStart: auto,
    session,
  };
}
