import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  DeepPlanPhase,
  DeepPlanRubric,
  DeepPlanSession,
  DeepPlanStatus,
} from '@shared/types';
import { DEEP_PLAN_PHASE_ORDER } from '@shared/types';
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

function emptyRoundsPerPhase(): Record<DeepPlanPhase, number> {
  return { ideation: 0, planning: 0, reviewing: 0, done: 0 };
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

/**
 * Best-effort backfill of legacy session files. Sessions written before the
 * phase rewrite had `stage` / `researchHints` / `skipped` at the top level.
 * We map the old stage family to a coarse phase so returning users don't
 * hit a crash — the loop will iterate from there.
 */
function backfillLegacy(parsed: Record<string, unknown>): void {
  if (!parsed.phase && typeof parsed.stage === 'string') {
    const stage = parsed.stage;
    const mapping: Record<string, DeepPlanPhase> = {
      intent: 'ideation',
      sources: 'ideation',
      scoping: 'ideation',
      gaps: 'planning',
      research: 'planning',
      synthesis: 'planning',
      handoff: 'reviewing',
      clarify: 'planning',
      review: 'reviewing',
      done: 'done',
    };
    parsed.phase = mapping[stage] ?? 'ideation';
    delete parsed.stage;
  }
  if (!parsed.phase) parsed.phase = 'ideation';
  if (!Array.isArray(parsed.researchQueries)) parsed.researchQueries = [];
  if (!Array.isArray(parsed.pendingQuestions)) parsed.pendingQuestions = [];
  if (
    !parsed.roundsPerPhase ||
    typeof parsed.roundsPerPhase !== 'object'
  ) {
    parsed.roundsPerPhase = emptyRoundsPerPhase();
  } else {
    const merged = { ...emptyRoundsPerPhase(), ...(parsed.roundsPerPhase as Record<string, number>) };
    parsed.roundsPerPhase = merged;
  }
  if (typeof parsed.skipped !== 'boolean') parsed.skipped = false;
  if (typeof parsed.completed !== 'boolean') parsed.completed = false;
  if (typeof parsed.tokensUsedK !== 'number') parsed.tokensUsedK = 0;
  // Drop fields that no longer exist so we don't carry dead weight forward.
  delete (parsed as { researchHints?: unknown }).researchHints;
}

export async function readSession(): Promise<DeepPlanSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    backfillLegacy(parsed);
    return parsed as unknown as DeepPlanSession;
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
    phase: 'ideation',
    task: task.trim(),
    rubric: emptyRubric(),
    messages: [],
    researchQueries: [],
    pendingQuestions: [],
    roundsPerPhase: emptyRoundsPerPhase(),
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

export function nextPhase(phase: DeepPlanPhase): DeepPlanPhase {
  const i = DEEP_PLAN_PHASE_ORDER.indexOf(phase);
  if (i < 0 || i === DEEP_PLAN_PHASE_ORDER.length - 1) return 'done';
  return DEEP_PLAN_PHASE_ORDER[i + 1]!;
}

export async function buildStatus(
  roundRunning: boolean = false,
): Promise<DeepPlanStatus> {
  const session = await readSession();
  const auto = await shouldAutoStart();
  return {
    active: session !== null && !session.completed && !session.skipped,
    shouldAutoStart: auto,
    session,
    roundRunning,
  };
}
