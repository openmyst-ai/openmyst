import { promises as fs } from 'node:fs';
import type { DeepSearchQueryRecord } from '@shared/types';
import { projectPath, ensureDir } from '../../platform';

/**
 * Deep Search persistence — the run is ephemeral (no rubric, no stage), but
 * the list of queries already tried + the cumulative ingested count needs to
 * survive app restarts so the user can see what's been explored before
 * deciding whether to re-run or steer in a new direction. Lives at
 * `.myst/deep-search/state.json`.
 */

export interface DeepSearchPersisted {
  task: string | null;
  queries: DeepSearchQueryRecord[];
  totalIngested: number;
  hints: string[];
  lastError: string | null;
  updatedAt: string;
}

function dir(): string {
  return projectPath('.myst', 'deep-search');
}

function filePath(): string {
  return projectPath('.myst', 'deep-search', 'state.json');
}

export async function readState(): Promise<DeepSearchPersisted | null> {
  try {
    const raw = await fs.readFile(filePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DeepSearchPersisted>;
    return {
      task: typeof parsed.task === 'string' ? parsed.task : null,
      queries: Array.isArray(parsed.queries) ? parsed.queries : [],
      totalIngested: typeof parsed.totalIngested === 'number' ? parsed.totalIngested : 0,
      hints: Array.isArray(parsed.hints) ? parsed.hints : [],
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeState(state: DeepSearchPersisted): Promise<void> {
  await ensureDir(dir());
  await fs.writeFile(filePath(), JSON.stringify(state, null, 2), 'utf-8');
}

export async function clearState(): Promise<void> {
  try {
    await fs.unlink(filePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
