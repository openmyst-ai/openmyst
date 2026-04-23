import type { DeepPlanSession } from '@shared/types';
import { log } from '../../platform';

/**
 * LLM-facing lookups for project-level context that used to be glued into the
 * system prompt on every turn: the active document, the Deep Plan plan.md +
 * requirements, and the research queries already run. Pulling these on demand
 * (via fences) keeps the default turn's system prompt small.
 *
 * Fence types, all optional:
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
 *   ```plan_lookup
 *   {}                                    // Deep Plan requirements + plan.md, if any
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
const PLAN_FENCE = /```plan_lookup\s*\n([\s\S]*?)```/g;
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

export function parsePlanLookups(text: string): { requests: true[]; stripped: string } {
  return parseFence<true>(text, PLAN_FENCE, () => true);
}

export function parseQueriesLookups(text: string): { requests: true[]; stripped: string } {
  return parseFence<true>(text, QUERIES_FENCE, () => true);
}

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

export interface PlanLookupPayload {
  /** The user's original task string, verbatim. */
  task: string;
  requirements: DeepPlanSession['requirements'];
  /** vision.md body — dot-point intellectual spine (replaces the old plan.md). */
  vision: string;
}

export function formatPlanReply(payload: PlanLookupPayload | null): string {
  if (!payload) {
    log('chat', 'contextLookup.plan.none');
    return '[plan_lookup — no Deep Plan session exists for this project. The user did not run Deep Plan, or skipped it.]';
  }
  const req = payload.requirements;
  const lines: string[] = [];
  lines.push(`Task: "${payload.task}"`);
  lines.push('');
  lines.push('Task requirements:');
  if (req.wordCountMin !== null && req.wordCountMax !== null) {
    if (req.wordCountMin === req.wordCountMax) {
      lines.push(`- Word count: ~${req.wordCountMin}`);
    } else {
      lines.push(`- Word count: ${req.wordCountMin}–${req.wordCountMax}`);
    }
  } else if (req.wordCountMin !== null) {
    lines.push(`- Word count: at least ${req.wordCountMin}`);
  } else if (req.wordCountMax !== null) {
    lines.push(`- Word count: at most ${req.wordCountMax}`);
  } else {
    lines.push('- Word count: (not specified)');
  }
  lines.push(`- Form: ${req.form ?? '(not specified)'}`);
  lines.push(`- Audience: ${req.audience ?? '(not specified)'}`);
  if (req.styleNotes) lines.push(`- Style notes: ${req.styleNotes}`);
  lines.push('');
  lines.push('vision.md:');
  lines.push(payload.vision.trim() || '(vision.md is empty — Deep Plan was skipped or started but not completed)');
  log('chat', 'contextLookup.plan.hit', {
    visionChars: payload.vision.length,
    hasWordCount: req.wordCountMin !== null || req.wordCountMax !== null,
  });
  return `[plan_lookup — Deep Plan vision + rubric from .myst/deep-plan/session.json]\n\n${lines.join('\n')}`;
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
