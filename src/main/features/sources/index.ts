import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { dialog } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { SourceAnchorSummary, SourceIndex, SourceMeta } from '@shared/types';
import { projectPath, pathExists, broadcast } from '../../platform';
import { updateWikiIndex, appendWikiLog } from '../wiki';
import { extractText } from './extract';
import { generateDigest, MAX_PREVIEW_CHARS, type SourceDigest } from './digest';
import { updateSourcesIndex } from './indexMd';

/**
 * Source ingestion — the orchestration layer on top of extract + digest +
 * index rewriting. This file is the one you touch when you add a new ingest
 * path (drag-and-drop, paste, URL fetcher…), not when you add a new file
 * format — that's `extract.ts`.
 *
 * Pipeline for every incoming source:
 *   1. extractText()       → raw text + type
 *   2. generateDigest()    → {name, summary, indexSummary} via LLM
 *   3. saveSource()        → write sources/<slug>.md + <slug>.meta.json
 *   4. updateSourcesIndex  → rewrite sources/index.md
 *   5. updateWikiIndex     → rewrite .myst/wiki/index.md (agent's memory)
 *   6. appendWikiLog       → audit trail entry
 *   7. broadcast Changed   → renderer refreshes the panel
 *
 * Everything after step 1 is idempotent, so a partial failure at step 4+
 * just leaves the user with the raw source on disk; re-running the ingest
 * reconciles it.
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

async function uniqueSlugFor(base: string): Promise<string> {
  let slug = base;
  let counter = 1;
  while (await pathExists(projectPath('sources', `${slug}.md`))) {
    slug = `${base}_${counter}`;
    counter++;
  }
  return slug;
}

async function saveSource(
  slug: string,
  digest: SourceDigest,
  type: SourceMeta['type'],
  originalName: string,
  rawText: string,
  sourcePath?: string,
): Promise<SourceMeta> {
  await fs.writeFile(projectPath('sources', `${slug}.md`), digest.summary, 'utf-8');

  // Persist the exact prefix the digest/anchor pass saw. Anchor offsets are
  // into this file; it must not be rewritten later.
  const rawForAnchors = rawText.slice(0, MAX_PREVIEW_CHARS);
  await fs.writeFile(projectPath('sources', `${slug}.raw.txt`), rawForAnchors, 'utf-8');

  if (digest.anchors.length > 0) {
    const index: SourceIndex = { version: 1, anchors: digest.anchors };
    await fs.writeFile(
      projectPath('sources', `${slug}.index.json`),
      JSON.stringify(index, null, 2),
      'utf-8',
    );
  }

  const anchorSummaries: SourceAnchorSummary[] = digest.anchors.map((a) => ({
    id: a.id,
    type: a.type,
    label: a.label,
  }));

  const meta: SourceMeta = {
    slug,
    name: digest.name,
    originalName,
    type,
    addedAt: new Date().toISOString(),
    summary: digest.summary,
    indexSummary: digest.indexSummary,
    sourcePath,
    anchors: anchorSummaries,
  };
  await fs.writeFile(
    projectPath('sources', `${slug}.meta.json`),
    JSON.stringify(meta, null, 2),
    'utf-8',
  );
  return meta;
}

export async function ingestSources(filePaths: string[]): Promise<SourceMeta[]> {
  const results: SourceMeta[] = [];
  const existing = await listSources();

  for (const filePath of filePaths) {
    const originalName = basename(filePath);
    const { text, type } = await extractText(filePath);
    const digest = await generateDigest(text, originalName, existing);
    const slug = await uniqueSlugFor(slugify(digest.name || originalName));
    const meta = await saveSource(slug, digest, type, originalName, text, filePath);
    results.push(meta);
  }

  const all = await listSources();
  await updateSourcesIndex(all);
  await updateWikiIndex(all);
  for (const m of results) {
    await appendWikiLog('ingest', `${m.name} (${m.slug})`);
  }
  broadcast(IpcChannels.Sources.Changed);
  return results;
}

function extractSourceUrl(text: string): string | undefined {
  // Preferred: explicit "Source URL: …" prefix we add for Tavily ingests.
  const explicit = text.match(/Source URL:\s*(\S+)/i);
  if (explicit) return explicit[1];
  // Fallback: first bare http(s) URL anywhere in the text. Covers older
  // Tavily sources where the URL only survived in the LLM summary body.
  const bare = text.match(/https?:\/\/[^\s)>\]]+/);
  return bare ? bare[0] : undefined;
}

export async function ingestText(text: string, title: string): Promise<SourceMeta> {
  const existing = await listSources();
  const digest = await generateDigest(text, title, existing);
  const slug = await uniqueSlugFor(slugify(digest.name || title));
  const sourcePath = extractSourceUrl(text);
  const meta = await saveSource(slug, digest, 'pasted', title, text, sourcePath);

  const all = await listSources();
  await updateSourcesIndex(all);
  await updateWikiIndex(all);
  await appendWikiLog('ingest', `${meta.name} (${meta.slug})`);
  broadcast(IpcChannels.Sources.Changed);
  return meta;
}

export async function pickSourceFiles(): Promise<string[]> {
  const result = await dialog.showOpenDialog({
    title: 'Add sources',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['pdf', 'md', 'markdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths;
}

export async function listSources(): Promise<SourceMeta[]> {
  const sourcesDir = projectPath('sources');
  let entries: string[];
  try {
    entries = await fs.readdir(sourcesDir);
  } catch {
    return [];
  }

  const metaFiles = entries.filter((e) => e.endsWith('.meta.json'));
  const results: SourceMeta[] = [];

  for (const metaFile of metaFiles) {
    try {
      const raw = await fs.readFile(projectPath('sources', metaFile), 'utf-8');
      const meta = JSON.parse(raw) as SourceMeta;
      // If the meta has no sourcePath but raw.txt opens with "Source URL: …"
      // (how we save Tavily results), lift that URL up so the preview can
      // show it. Covers sources ingested before we started storing it.
      if (!meta.sourcePath) {
        // Try raw.txt first (has the literal "Source URL: …" prefix we write
        // for Tavily ingests), then fall back to summary.md for older
        // sources that predate raw.txt storage.
        let url: string | undefined;
        try {
          const rawText = await fs.readFile(
            projectPath('sources', `${meta.slug}.raw.txt`),
            'utf-8',
          );
          url = extractSourceUrl(rawText);
        } catch {
          // no raw.txt — fine
        }
        if (!url) {
          try {
            const summaryText = await fs.readFile(
              projectPath('sources', `${meta.slug}.md`),
              'utf-8',
            );
            url = extractSourceUrl(summaryText);
          } catch {
            // no summary — give up
          }
        }
        if (url) meta.sourcePath = url;
      }
      results.push(meta);
    } catch {
      // skip corrupt meta files
    }
  }

  results.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return results;
}

export async function readSource(slug: string): Promise<string> {
  return fs.readFile(projectPath('sources', `${slug}.md`), 'utf-8');
}

export async function deleteSource(slug: string): Promise<void> {
  await fs.unlink(projectPath('sources', `${slug}.md`)).catch(() => {});
  await fs.unlink(projectPath('sources', `${slug}.meta.json`)).catch(() => {});
  await fs.unlink(projectPath('sources', `${slug}.raw.txt`)).catch(() => {});
  await fs.unlink(projectPath('sources', `${slug}.index.json`)).catch(() => {});

  const all = await listSources();
  await updateSourcesIndex(all);
  await updateWikiIndex(all);
  await appendWikiLog('delete', slug);
  broadcast(IpcChannels.Sources.Changed);
}
