import { promises as fs } from 'node:fs';
import type { SourceIndex, SourceAnchor, SourceMeta } from '@shared/types';
import { projectPath, pathExists } from '../../platform';

/**
 * Deterministic deep-reference lookup. Given a source slug and an anchor id,
 * returns the exact verbatim text stored between the anchor's char offsets.
 * No LLM scanning, no full-file read into memory — we `fs.read` just the
 * byte range we need from `<slug>.raw.txt`.
 *
 * Call sites: parse a `source_lookup` block from an LLM response, call this,
 * inject the result back into the conversation as a follow-up message.
 */

export interface AnchorLookupHit {
  slug: string;
  anchor: SourceAnchor;
  text: string;
  /** Source display name + origin URL, pulled from `<slug>.meta.json`. Lets
   *  the hover UI show provenance without a second IPC round-trip. Either
   *  may be undefined for old sources missing the meta file. */
  sourceName?: string;
  sourceUrl?: string;
}

async function readIndex(slug: string): Promise<SourceIndex | null> {
  const path = projectPath('sources', `${slug}.index.json`);
  if (!(await pathExists(path))) return null;
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as SourceIndex;
  } catch {
    return null;
  }
}

async function readMetaLite(
  slug: string,
): Promise<{ name: string; sourcePath?: string } | null> {
  const metaPath = projectPath('sources', `${slug}.meta.json`);
  if (!(await pathExists(metaPath))) return null;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SourceMeta;
    return { name: meta.name, sourcePath: meta.sourcePath };
  } catch {
    return null;
  }
}

export async function readAnchor(
  slug: string,
  anchorId: string,
): Promise<AnchorLookupHit | null> {
  const index = await readIndex(slug);
  if (!index) return null;
  const anchor = index.anchors.find((a) => a.id === anchorId);
  if (!anchor) return null;
  const meta = await readMetaLite(slug);
  const metaFields = meta
    ? { sourceName: meta.name, sourceUrl: meta.sourcePath }
    : {};
  // Prefer the verbatim text stored on the anchor itself — this is the
  // post-phase-1 path where extraction persists the passage at index time.
  // Fall back to a byte-range read for older indexes that were written
  // before `text` existed.
  if (typeof anchor.text === 'string' && anchor.text.length > 0) {
    return { slug, anchor, text: anchor.text, ...metaFields };
  }
  const rawPath = projectPath('sources', `${slug}.raw.txt`);
  if (!(await pathExists(rawPath))) return null;
  const raw = await fs.readFile(rawPath, 'utf-8');
  const text = raw.slice(anchor.charStart, anchor.charEnd);
  return { slug, anchor, text, ...metaFields };
}

export async function listAnchorSummaries(
  slug: string,
): Promise<Pick<SourceAnchor, 'id' | 'type' | 'label'>[]> {
  const index = await readIndex(slug);
  if (!index) return [];
  return index.anchors.map((a) => ({ id: a.id, type: a.type, label: a.label }));
}

export interface SourcePageHit {
  slug: string;
  meta: Pick<SourceMeta, 'name' | 'indexSummary' | 'sourcePath'>;
  summary: string;
  anchors: Pick<SourceAnchor, 'id' | 'type' | 'label'>[];
}

/**
 * Slug-only source lookup — the "open the full source page" action. Returns
 * the detailed summary (sources/<slug>.md) plus the anchor index so the LLM
 * can decide which anchor to pull next. No raw text, no verbatim quotes — the
 * agent has to `source_lookup` a specific anchor for that.
 */
export async function readSourcePage(slug: string): Promise<SourcePageHit | null> {
  const metaPath = projectPath('sources', `${slug}.meta.json`);
  const summaryPath = projectPath('sources', `${slug}.md`);
  if (!(await pathExists(metaPath)) || !(await pathExists(summaryPath))) return null;
  try {
    const rawMeta = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(rawMeta) as SourceMeta;
    const summary = await fs.readFile(summaryPath, 'utf-8');
    const anchors = await listAnchorSummaries(slug);
    return {
      slug,
      meta: {
        name: meta.name,
        indexSummary: meta.indexSummary,
        sourcePath: meta.sourcePath,
      },
      summary,
      anchors,
    };
  } catch {
    return null;
  }
}

export interface RawFileHit {
  slug: string;
  filename: string;
  text: string;
  totalBytes: number;
  truncated: boolean;
}

/**
 * Cap for raw-file lookups. 50 KB is ~12k tokens worst case — big enough for
 * most scripts and small data files, small enough not to blow out the chat
 * context. Anything above the cap is truncated with a marker so the agent
 * knows what it's missing.
 */
const RAW_READ_CAP_BYTES = 50 * 1024;

/**
 * Read the verbatim contents of a raw-typed source. Returns `null` if the
 * slug doesn't exist or isn't a raw source. Callers should fall back to
 * `readSourcePage` in that case.
 */
export async function readRawFile(slug: string): Promise<RawFileHit | null> {
  const metaPath = projectPath('sources', `${slug}.meta.json`);
  if (!(await pathExists(metaPath))) return null;
  let meta: SourceMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SourceMeta;
  } catch {
    return null;
  }
  if (meta.type !== 'raw' || !meta.rawFile) return null;

  const filePath = projectPath('sources', meta.rawFile);
  if (!(await pathExists(filePath))) return null;

  const stat = await fs.stat(filePath);
  const buf = await fs.readFile(filePath);
  const truncated = buf.length > RAW_READ_CAP_BYTES;
  const slice = truncated ? buf.subarray(0, RAW_READ_CAP_BYTES) : buf;
  // `utf8` — raw sources are expected to be text. Binary files would show up
  // as garbled but we don't accept binaries through the pickFiles filter.
  return {
    slug,
    filename: meta.rawFile,
    text: slice.toString('utf8'),
    totalBytes: stat.size,
    truncated,
  };
}
