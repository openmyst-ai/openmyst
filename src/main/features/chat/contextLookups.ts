import type { DeepPlanRubric } from '@shared/types';
import { log } from '../../platform';

/**
 * LLM-facing lookups for project-level context that used to be glued into the
 * system prompt on every turn: the active document, the Deep Plan rubric, and
 * the research queries already run. Pulling these on demand (via fences) cuts
 * the default turn's system prompt by the size of the doc plus ~500w of
 * rubric/queries scaffolding.
 *
 * Three new fence types, all optional:
 *
 *   ```doc_lookup
 *   {}                                   // full current contents of the active doc
 *   ```
 *
 *   ```doc_lookup
 *   {"find": "pareto optimality"}        // return the paragraph(s) containing this
 *   ```                                   // substring (case-insensitive)
 *
 *   ```doc_lookup
 *   {"from": 0, "to": 2000}              // byte-range slice of the doc
 *   ```
 *
 *   ```rubric_lookup
 *   {}                                    // full Deep Plan rubric, if any
 *   ```
 *
 *   ```queries_lookup
 *   {}                                    // research queries already run
 *   ```
 *
 * Parsing is I/O-free. Resolvers are handed the resolved context directly
 * from the turn orchestrator, so no disk access happens here.
 */

const DOC_FENCE = /```doc_lookup\s*\n([\s\S]*?)```/g;
const RUBRIC_FENCE = /```rubric_lookup\s*\n([\s\S]*?)```/g;
const QUERIES_FENCE = /```queries_lookup\s*\n([\s\S]*?)```/g;

export interface DocLookupRequest {
  find?: string;
  from?: number;
  to?: number;
}

function parseFence<T>(text: string, re: RegExp, cast: (obj: unknown) => T | null): {
  requests: T[];
  stripped: string;
} {
  const requests: T[] = [];
  let stripped = text;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    const body = match[1]!.trim();
    let parsed: unknown = {};
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body);
      } catch {
        // tolerate empty / malformed bodies — treat as no-args
        parsed = {};
      }
    }
    const req = cast(parsed);
    if (req) requests.push(req);
    stripped = stripped.replace(match[0], '');
  }
  return { requests, stripped: stripped.trim() };
}

export function parseDocLookups(text: string): { requests: DocLookupRequest[]; stripped: string } {
  return parseFence<DocLookupRequest>(text, DOC_FENCE, (raw) => {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const req: DocLookupRequest = {};
    if (typeof obj.find === 'string' && obj.find.length > 0) req.find = obj.find;
    if (typeof obj.from === 'number' && obj.from >= 0) req.from = Math.floor(obj.from);
    if (typeof obj.to === 'number' && obj.to > 0) req.to = Math.floor(obj.to);
    return req;
  });
}

export function parseRubricLookups(text: string): { requests: true[]; stripped: string } {
  return parseFence<true>(text, RUBRIC_FENCE, () => true);
}

export function parseQueriesLookups(text: string): { requests: true[]; stripped: string } {
  return parseFence<true>(text, QUERIES_FENCE, () => true);
}

/**
 * Slice the doc around the first occurrence of `find` — one paragraph before
 * and after, so the model sees enough context to know what it's editing
 * without pulling the whole doc.
 */
function paragraphWindowAround(doc: string, needle: string): string | null {
  const hay = doc.toLowerCase();
  const n = needle.toLowerCase();
  const idx = hay.indexOf(n);
  if (idx === -1) return null;
  const paragraphs = doc.split(/\n{2,}/);
  let cursor = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]!;
    const end = cursor + p.length;
    if (idx >= cursor && idx <= end) {
      const before = i > 0 ? paragraphs[i - 1] : '';
      const after = i + 1 < paragraphs.length ? paragraphs[i + 1] : '';
      return [before, p, after].filter((x) => x && x.length > 0).join('\n\n');
    }
    cursor = end + 2;
  }
  return null;
}

export function formatDocReply(
  docLabel: string,
  doc: string,
  requests: DocLookupRequest[],
): string {
  const parts: string[] = [];
  for (const req of requests) {
    if (req.find) {
      const window = paragraphWindowAround(doc, req.find);
      if (window) {
        log('chat', 'contextLookup.doc.find.hit', { needle: req.find, len: window.length });
        parts.push(
          `[doc_lookup hit — paragraph window around "${req.find}" in ${docLabel}]\n\n${window}`,
        );
      } else {
        log('chat', 'contextLookup.doc.find.miss', { needle: req.find });
        parts.push(
          `[doc_lookup miss — "${req.find}" not found in ${docLabel}. Pull the full doc with \`{}\` if needed.]`,
        );
      }
      continue;
    }
    if (typeof req.from === 'number' || typeof req.to === 'number') {
      const from = req.from ?? 0;
      const to = req.to ?? doc.length;
      const slice = doc.slice(from, Math.min(to, doc.length));
      log('chat', 'contextLookup.doc.range', { from, to, len: slice.length });
      parts.push(
        `[doc_lookup range — ${docLabel} chars ${from}..${Math.min(to, doc.length)} of ${doc.length}]\n\n${slice}`,
      );
      continue;
    }
    log('chat', 'contextLookup.doc.full', { len: doc.length });
    parts.push(`[doc_lookup — full current contents of ${docLabel} (${doc.length} chars)]\n\n${doc}`);
  }
  return parts.join('\n\n---\n\n');
}

export function formatRubricReply(rubric: DeepPlanRubric | null): string {
  if (!rubric) {
    log('chat', 'contextLookup.rubric.none');
    return '[rubric_lookup — no Deep Plan rubric exists for this project. The user did not run Deep Plan, or skipped it.]';
  }
  const lines: string[] = [];
  if (rubric.title) lines.push(`Title: ${rubric.title}`);
  if (rubric.form) lines.push(`Form: ${rubric.form}`);
  if (rubric.audience) lines.push(`Audience: ${rubric.audience}`);
  if (rubric.lengthTarget) lines.push(`Length target: ${rubric.lengthTarget}`);
  if (rubric.thesis) lines.push(`Thesis: ${rubric.thesis}`);
  if (rubric.mustCover.length > 0) {
    lines.push('', 'Must cover:');
    for (const m of rubric.mustCover) lines.push(`- ${m}`);
  }
  if (rubric.mustAvoid.length > 0) {
    lines.push('', 'Must avoid:');
    for (const m of rubric.mustAvoid) lines.push(`- ${m}`);
  }
  const notes = rubric.notes.trim();
  if (notes) {
    lines.push('', 'Notes:', notes);
  }
  log('chat', 'contextLookup.rubric.hit', { fields: lines.length });
  return `[rubric_lookup — Deep Plan rubric from .myst/deep-plan/session.json]\n\n${lines.join('\n')}`;
}

export function formatQueriesReply(queries: string[]): string {
  if (queries.length === 0) {
    log('chat', 'contextLookup.queries.none');
    return '[queries_lookup — no research queries have been run yet for this project.]';
  }
  log('chat', 'contextLookup.queries.hit', { count: queries.length });
  return (
    `[queries_lookup — ${queries.length} research queries already run across Deep Plan and Deep Search]\n\n` +
    queries.map((q) => `- "${q}"`).join('\n')
  );
}
