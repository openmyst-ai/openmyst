import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  DeepPlanPhase,
  DeepPlanSession,
  DeepPlanStatus,
  PlanRequirements,
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

function emptyRoundsPerPhase(): Record<DeepPlanPhase, number> {
  return { ideation: 0, planning: 0, reviewing: 0, done: 0 };
}

function emptyRequirements(): PlanRequirements {
  return {
    wordCountMin: null,
    wordCountMax: null,
    form: null,
    audience: null,
    styleNotes: null,
  };
}

/**
 * Best-effort extraction of hard constraints from a freeform task string.
 * We only pull what we can detect with high confidence — anything ambiguous
 * stays null and gets filled in later by the Chair as the panel converges.
 */
export function extractRequirements(task: string): PlanRequirements {
  const out = emptyRequirements();
  const lower = task.toLowerCase();

  // Word-count range: "1500-2500 words" / "1500 to 2500 words" / "~2000 words"
  const rangeMatch = lower.match(
    /(\d{3,6})\s*(?:-|–|to|\s)\s*(\d{3,6})\s*words?/,
  );
  if (rangeMatch) {
    out.wordCountMin = Number(rangeMatch[1]);
    out.wordCountMax = Number(rangeMatch[2]);
  } else {
    // Single target: "~2000 words" / "2000 words" / "a 2000-word essay"
    const singleMatch = lower.match(/(\d{3,6})[-\s]?words?/);
    if (singleMatch) {
      const n = Number(singleMatch[1]);
      out.wordCountMin = n;
      out.wordCountMax = n;
    }
  }

  // Form — match against a small known vocabulary. If none fits, leave null.
  const forms = [
    'essay',
    'blog post',
    'blog',
    'article',
    'report',
    'memo',
    'review',
    'op-ed',
    'editorial',
    'whitepaper',
    'case study',
    'feature',
    'profile',
  ];
  for (const f of forms) {
    if (lower.includes(f)) {
      out.form = f;
      break;
    }
  }

  // Audience — look for "for <X>" patterns. Crude but gets the common case.
  const audienceMatch = task.match(
    /\bfor\s+(?:a\s+|an\s+|the\s+)?([a-zA-Z][a-zA-Z\s-]{3,40}?)\s+(?:audience|readers?|community|crowd)\b/i,
  );
  if (audienceMatch) out.audience = audienceMatch[1]!.trim();

  return out;
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
 * Best-effort backfill of legacy session files. Anything written before
 * the plan.md rewrite carried a `rubric` + `researchQueries` shape; we
 * drop those and seed the new fields so returning users don't crash. The
 * loop will pick up wherever the old phase marker says.
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
  if (!Array.isArray(parsed.pendingQuestions)) parsed.pendingQuestions = [];
  if (typeof parsed.plan !== 'string') parsed.plan = '';
  if (
    !parsed.requirements ||
    typeof parsed.requirements !== 'object'
  ) {
    parsed.requirements = emptyRequirements();
  } else {
    parsed.requirements = {
      ...emptyRequirements(),
      ...(parsed.requirements as Record<string, unknown>),
    };
  }
  if (typeof parsed.searchesUsed !== 'number') parsed.searchesUsed = 0;
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
  delete (parsed as { researchQueries?: unknown }).researchQueries;
  delete (parsed as { rubric?: unknown }).rubric;
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
  const trimmed = task.trim();
  const session: DeepPlanSession = {
    id: randomUUID(),
    projectPath: root,
    phase: 'ideation',
    task: trimmed,
    requirements: extractRequirements(trimmed),
    plan: '',
    messages: [],
    pendingQuestions: [],
    roundsPerPhase: emptyRoundsPerPhase(),
    searchesUsed: 0,
    tokensUsedK: 0,
    createdAt: now,
    updatedAt: now,
    skipped: false,
    completed: false,
  };
  await writeSession(session);
  log('deep-plan', 'session.created', {
    task: trimmed.slice(0, 120),
    requirements: session.requirements,
  });
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
