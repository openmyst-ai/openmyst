import { promises as fs } from 'node:fs';
import { basename, extname } from 'node:path';
import { dialog } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type {
  AnchorLogEntry,
  SourceAnchorSummary,
  SourceIndex,
  SourceMeta,
  SourceRole,
} from '@shared/types';
import { projectPath, pathExists, broadcast } from '../../platform';
import { updateWikiIndex, appendWikiLog } from '../wiki';
import { extractText } from './extract';
import { generateDigest, MAX_PREVIEW_CHARS, type SourceDigest } from './digest';
import { updateSourcesIndex } from './indexMd';
import { fetchUrlAsMarkdown } from '../research/fetch';

/**
 * Extensions we send through the LLM digest pipeline. Everything else is
 * treated as a raw file — copied in verbatim, no summary, agent reads on
 * demand via `source_lookup` with `raw: true`. `.txt` stays on the summary
 * side since small text notes are typically prose worth summarising; code
 * and data files aren't.
 */
const SUMMARY_EXTS: ReadonlySet<string> = new Set(['.pdf', '.md', '.markdown', '.txt']);

/**
 * Friendly labels for the index line ("Raw Python file (train.py)"). Used
 * purely for the human/agent-readable summary string — mime type / editor
 * choices stay driven by the extension itself.
 */
const RAW_LANG_LABELS: Record<string, string> = {
  '.py': 'Python',
  '.pyw': 'Python',
  '.ipynb': 'Jupyter notebook',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.csv': 'CSV',
  '.tsv': 'TSV',
  '.json': 'JSON',
  '.jsonl': 'JSONL',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.ini': 'INI',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.fish': 'Shell',
  '.sql': 'SQL',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cxx': 'C++',
  '.hpp': 'C++',
  '.cs': 'C#',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.xml': 'XML',
  '.log': 'Log',
  '.env': 'Env',
};

function rawLangLabel(ext: string): string {
  return RAW_LANG_LABELS[ext.toLowerCase()] ?? 'file';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

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
    role: digest.role,
  };
  if (digest.bibliographic) meta.bibliographic = digest.bibliographic;
  await fs.writeFile(
    projectPath('sources', `${slug}.meta.json`),
    JSON.stringify(meta, null, 2),
    'utf-8',
  );
  return meta;
}

async function saveRawSource(filePath: string): Promise<SourceMeta> {
  const originalName = basename(filePath);
  const ext = extname(originalName);
  const stat = await fs.stat(filePath);
  const lang = rawLangLabel(ext);

  // slug from the bare filename — keeps it predictable when the agent
  // references it (`train_py` for `train.py`). ext is preserved in the
  // stored filename so IDE previews / `file` command still work.
  const baseSlug = slugify(originalName);
  const slug = await uniqueSlugFor(baseSlug);
  const rawFile = `${slug}${ext}`;
  await fs.copyFile(filePath, projectPath('sources', rawFile));

  const indexSummary = `Raw ${lang} file (${originalName}, ${formatBytes(stat.size)}) — not summarized. Pull contents via \`source_lookup\` with \`"raw": true\`.`;
  // User-facing body shown in the sources pane. Short and reassuring — the
  // file is still usable, just not auto-summarised. No protocol details here;
  // those belong in the stub .md below, which the agent reads, not the human.
  const summary = `No summary — raw ${lang} file (${formatBytes(stat.size)}). Full contents stay indexed and the agent reads them on demand.`;

  // Stub .md returned when the agent hits `source_lookup {"slug":"..."}`
  // without an anchor. Tells it how to read the raw bytes.
  const agentStub =
    `**${originalName}** — raw ${lang} file, ${formatBytes(stat.size)}.\n\n` +
    `This source is not summarised. To read the full contents, emit a \`source_lookup\` block with \`{"slug": "${slug}", "raw": true}\`. ` +
    `The verbatim file will be returned (capped at 50 KB — anything larger is truncated with a marker).`;
  await fs.writeFile(projectPath('sources', `${slug}.md`), agentStub, 'utf-8');

  const meta: SourceMeta = {
    slug,
    name: originalName,
    originalName,
    type: 'raw',
    addedAt: new Date().toISOString(),
    summary,
    indexSummary,
    sourcePath: filePath,
    anchors: [],
    rawFile,
    sizeBytes: stat.size,
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
    const ext = extname(filePath).toLowerCase();
    if (SUMMARY_EXTS.has(ext)) {
      const originalName = basename(filePath);
      const { text, type } = await extractText(filePath);
      const digest = await generateDigest(text, originalName, existing);
      const slug = await uniqueSlugFor(slugify(digest.name || originalName));
      const meta = await saveSource(slug, digest, type, originalName, text, filePath);
      results.push(meta);
    } else {
      results.push(await saveRawSource(filePath));
    }
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
  const digest = await prepareIngestDigest(text, title, existing);
  return saveIngestedDigest(text, title, digest);
}

/**
 * LLM-only half of ingestion — safe to run concurrently for a batch of
 * sources because it touches no filesystem state. Pair with
 * `saveIngestedDigest` (which must be serialised) to persist the result.
 */
export async function prepareIngestDigest(
  text: string,
  title: string,
  existingSources: SourceMeta[],
): Promise<SourceDigest> {
  return generateDigest(text, title, existingSources);
}

/**
 * Serial half of ingestion — writes the source file and rebuilds the
 * sources/wiki indexes. Must not run concurrently with other ingests or
 * index updates race and one wins.
 */
export async function saveIngestedDigest(
  text: string,
  title: string,
  digest: SourceDigest,
): Promise<SourceMeta> {
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

export async function ingestLink(url: string): Promise<SourceMeta> {
  const page = await fetchUrlAsMarkdown(url);
  // Prepend "Source URL: …" so listSources() and extractSourceUrl() pick it
  // up consistently with how Tavily/Jina-sourced pages get stored.
  const text = `Source URL: ${page.url}\n\n${page.markdown}`;
  const existing = await listSources();
  const digest = await generateDigest(text, page.title, existing);
  const slug = await uniqueSlugFor(slugify(digest.name || page.title));
  const meta = await saveSource(slug, digest, 'link', page.title, text, page.url);

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
      // "All Files" up top so the default picker lets users drop in any
      // code/data file — the whole point of raw sources. Summary types
      // stay listed so markdown/PDF users can still filter.
      { name: 'All Files', extensions: ['*'] },
      { name: 'Documents (summarised)', extensions: ['pdf', 'md', 'markdown', 'txt'] },
      {
        name: 'Code & data (raw)',
        extensions: [
          'py', 'ipynb', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
          'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini',
          'sh', 'bash', 'zsh', 'sql',
          'go', 'rs', 'rb', 'java', 'kt', 'swift',
          'c', 'h', 'cpp', 'cxx', 'hpp', 'cs',
          'html', 'htm', 'xml', 'log',
        ],
      },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths;
}

/**
 * Signature of the old raw-source summary body. Pre-0.1.1 ingests stored a
 * verbose blurb explaining the `source_lookup` protocol to the LLM in the
 * user-visible `summary` field; the user sees that text in the sources pane
 * and it reads like jargon. Any stored summary containing this phrase is a
 * legacy raw-source summary and gets rewritten lazily below.
 */
const LEGACY_RAW_SUMMARY_MARKER = 'This source is not summarised. To read the full contents';

function buildRawSourceSummary(meta: SourceMeta): string {
  const ext = meta.rawFile ? extname(meta.rawFile) : extname(meta.originalName);
  const lang = rawLangLabel(ext);
  const size = typeof meta.sizeBytes === 'number' ? formatBytes(meta.sizeBytes) : 'unknown size';
  return `No summary — raw ${lang} file (${size}). Full contents stay indexed and the agent reads them on demand.`;
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

      // One-shot migration for raw sources ingested before the user-friendly
      // summary split. Rewrite the .meta.json in place so future reads don't
      // pay the cost, but don't touch the `.md` stub — that one is read by
      // the agent and still needs the `source_lookup` instructions.
      if (meta.type === 'raw' && meta.summary.includes(LEGACY_RAW_SUMMARY_MARKER)) {
        meta.summary = buildRawSourceSummary(meta);
        await fs.writeFile(
          projectPath('sources', metaFile),
          JSON.stringify(meta, null, 2),
          'utf-8',
        ).catch(() => {
          // Best-effort persist; on failure we still return the migrated
          // summary in memory so the UI looks right this session.
        });
      }
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

/**
 * Flatten every anchor from every ingested source into a single list
 * ready for the UI + drafter to consume. Reads `<slug>.index.json` for
 * each source and joins it with the source's display-name + URL from
 * meta. Sources without an index (raw files, failed digest) contribute
 * nothing — they just don't show up in the anchor list, which is correct.
 *
 * This is the deterministic replacement for the old session-side anchor
 * log. No curation, no append path — the union of source indexes IS the
 * anchor list.
 */
export async function listAllAnchors(): Promise<AnchorLogEntry[]> {
  const sources = await listSources();
  const out: AnchorLogEntry[] = [];
  await Promise.all(
    sources.map(async (s) => {
      const indexPath = projectPath('sources', `${s.slug}.index.json`);
      if (!(await pathExists(indexPath))) return;
      let index: SourceIndex;
      try {
        index = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as SourceIndex;
      } catch {
        return;
      }
      for (const a of index.anchors) {
        // Every anchor stored in the index has the verbatim `text` field
        // (Phase 1 of the anchoring work). Older sources without it are
        // skipped — they'd render as empty cards otherwise.
        if (typeof a.text !== 'string' || !a.text.trim()) continue;
        const entry: AnchorLogEntry = {
          id: `${s.slug}#${a.id}`,
          slug: s.slug,
          sourceName: s.name,
          type: a.type,
          text: a.text,
          keywords: a.keywords ?? [],
          role: s.role ?? 'reference',
        };
        if (s.sourcePath) entry.sourceUrl = s.sourcePath;
        if (s.bibliographic) entry.bibliographic = s.bibliographic;
        out.push(entry);
      }
    }),
  );
  return out;
}

/**
 * Flip a source between `'reference'` and `'guidance'`. Persists to the
 * meta file and broadcasts so the renderer refreshes. Used when the digest
 * misclassified a source (e.g. tagged a method guide as `'reference'`),
 * letting the user fix it without re-ingesting.
 */
export async function setSourceRole(slug: string, role: SourceRole): Promise<SourceMeta> {
  const path = projectPath('sources', `${slug}.meta.json`);
  const raw = await fs.readFile(path, 'utf-8');
  const meta = JSON.parse(raw) as SourceMeta;
  meta.role = role;
  await fs.writeFile(path, JSON.stringify(meta, null, 2), 'utf-8');
  broadcast(IpcChannels.Sources.Changed);
  return meta;
}

export async function deleteSource(slug: string): Promise<void> {
  // For raw sources, we need to clean up the copied-in file too — the meta
  // carries its filename. Read it before unlinking anything else.
  let rawFile: string | undefined;
  try {
    const rawMeta = await fs.readFile(projectPath('sources', `${slug}.meta.json`), 'utf-8');
    rawFile = (JSON.parse(rawMeta) as SourceMeta).rawFile;
  } catch {
    // no meta — nothing to clean up beyond the standard triple
  }

  await fs.unlink(projectPath('sources', `${slug}.md`)).catch(() => {});
  await fs.unlink(projectPath('sources', `${slug}.meta.json`)).catch(() => {});
  await fs.unlink(projectPath('sources', `${slug}.raw.txt`)).catch(() => {});
  await fs.unlink(projectPath('sources', `${slug}.index.json`)).catch(() => {});
  if (rawFile) {
    await fs.unlink(projectPath('sources', rawFile)).catch(() => {});
  }

  const all = await listSources();
  await updateSourcesIndex(all);
  await updateWikiIndex(all);
  await appendWikiLog('delete', slug);
  broadcast(IpcChannels.Sources.Changed);
}
