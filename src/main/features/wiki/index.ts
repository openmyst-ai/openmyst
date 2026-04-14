import { promises as fs } from 'node:fs';
import type { SourceMeta } from '@shared/types';
import { projectPath, ensureDir, log } from '../../platform';

/**
 * The research wiki: a persistent, LLM-maintained knowledge base that lives
 * under .myst/wiki/ and is loaded into every chat turn as the agent's
 * default memory. The user never sees it directly in the file tree — the
 * agent reads from it to think, writes to it to remember, and the graph
 * popup renders its shape as a trust signal for what's happening under the
 * hood.
 *
 * Layout:
 *   .myst/wiki/index.md  — master index (sources, concepts, findings)
 *   .myst/wiki/log.md    — append-only activity log
 *
 * Source summaries themselves stay at sources/<slug>.md (existing layout,
 * visible in the project folder). The wiki index points at them.
 */

export { computeWikiGraph } from './graph';

function wikiRoot(): string {
  return projectPath('.myst', 'wiki');
}

function indexPath(): string {
  return projectPath('.myst', 'wiki', 'index.md');
}

function logPath(): string {
  return projectPath('.myst', 'wiki', 'log.md');
}

export async function ensureWikiDir(): Promise<void> {
  await ensureDir(wikiRoot());
}

export async function readWikiIndex(): Promise<string> {
  try {
    return await fs.readFile(indexPath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export async function updateWikiIndex(sources: SourceMeta[]): Promise<void> {
  await ensureWikiDir();
  const lines: string[] = [];
  lines.push('# Research Wiki Index');
  lines.push('');
  lines.push(
    '_Auto-maintained by the agent. This is the default memory surface: read it before every chat turn to orient yourself, then pull the specific source pages you need._',
  );
  lines.push('');
  lines.push('## Sources');
  if (sources.length === 0) {
    lines.push('');
    lines.push('_No sources yet._');
  } else {
    for (const s of sources) {
      const anchorHint =
        s.anchors && s.anchors.length > 0 ? ` _(${s.anchors.length} anchors)_` : '';
      lines.push(
        `- [${s.name}](../../sources/${s.slug}.md) (\`${s.slug}\`) — ${s.indexSummary}${anchorHint}`,
      );
    }
  }
  lines.push('');
  lines.push('## Concepts');
  lines.push('');
  lines.push(
    '_Cross-cutting themes, methods, or ideas that span multiple sources. Create a concept page (wiki/concepts/<slug>.md) and link it here when you notice a pattern worth naming._',
  );
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  lines.push(
    '_Experimental results, observations, and conclusions. Tie each back to the source(s) or doc(s) that motivated it._',
  );
  lines.push('');
  await fs.writeFile(indexPath(), lines.join('\n'), 'utf-8');
  log('wiki', 'index.updated', { sourceCount: sources.length });
}

export async function appendWikiLog(type: string, description: string): Promise<void> {
  await ensureWikiDir();
  const date = new Date().toISOString().slice(0, 10);
  const line = `## [${date}] ${type} | ${description}\n`;
  try {
    await fs.access(logPath());
    await fs.appendFile(logPath(), line, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.writeFile(logPath(), `# Research Log\n\n${line}`, 'utf-8');
    } else {
      throw err;
    }
  }
  log('wiki', 'log.appended', { type, description: description.slice(0, 80) });
}
