import type { DeepPlanRubric } from '@shared/types';

/**
 * Parsers for the structured blocks the planner emits inside its free-text
 * replies. Two block types:
 *   - ```rubric_update\n{...}``` — partial rubric patch
 *   - ```research_plan\n[...]``` — array of queries to run
 *
 * Extraction is forgiving: the model sometimes wraps the block in prose, or
 * forgets the opening/closing fence. We grab the first JSON-looking thing
 * inside a matching fenced block and fall back to nothing on parse failure.
 */

export interface ResearchQueryProposal {
  query: string;
  rationale: string;
}

export interface ParsedPlannerReply {
  chat: string;
  rubricPatch: Partial<DeepPlanRubric> | null;
  researchPlan: ResearchQueryProposal[] | null;
}

const RUBRIC_FENCE = /```\s*rubric_update\s*\n([\s\S]*?)```/i;
const RESEARCH_FENCE = /```\s*research_plan\s*\n([\s\S]*?)```/i;

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Per-field aliases. Models regularly emit snake_case despite the prompt
 * asking for camelCase — silently accepting both is cheaper than re-prompting.
 */
const FIELD_ALIASES: Record<string, keyof DeepPlanRubric> = {
  title: 'title',
  form: 'form',
  audience: 'audience',
  lengthTarget: 'lengthTarget',
  length_target: 'lengthTarget',
  thesis: 'thesis',
  mustCover: 'mustCover',
  must_cover: 'mustCover',
  mustAvoid: 'mustAvoid',
  must_avoid: 'mustAvoid',
  notes: 'notes',
};

function sanitizeRubricPatch(obj: unknown): Partial<DeepPlanRubric> | null {
  if (!obj || typeof obj !== 'object') return null;
  const src = obj as Record<string, unknown>;
  const out: Partial<DeepPlanRubric> = {};

  for (const [incoming, canonical] of Object.entries(FIELD_ALIASES)) {
    if (!(incoming in src)) continue;
    const v = src[incoming];
    if (canonical === 'mustCover' || canonical === 'mustAvoid') {
      if (Array.isArray(v)) {
        out[canonical] = v.filter((x): x is string => typeof x === 'string');
      }
      continue;
    }
    if (typeof v === 'string') {
      (out as Record<string, unknown>)[canonical] = v;
    } else if (v === null) {
      (out as Record<string, unknown>)[canonical] = null;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Scan backwards from the end of `text` for a top-level balanced JSON
 * block (`{…}` or `[…]`). Returns the inclusive `[start, end)` byte range
 * of the block if one is found with only whitespace after it, else null.
 *
 * We only call this as a fallback when the proper ```rubric_update fence
 * wasn't present — which happens when the model forgets the fence and
 * emits bare JSON at the end of its reply (historically common in the
 * clarify stage). Strips it from the visible chat so users don't see raw
 * JSON and, where the JSON parses as a rubric patch, still feeds the
 * rubric update through.
 *
 * Scans by counting matching braces starting from the final `}` / `]`,
 * so it handles nested objects/arrays correctly. Won't false-trigger on
 * prose because chat messages essentially never end with a literal
 * closing brace.
 */
function findTrailingJsonBlock(text: string): { start: number; end: number } | null {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length === 0) return null;
  const last = trimmed[trimmed.length - 1]!;
  if (last !== '}' && last !== ']') return null;
  const openFor: Record<string, string> = { '}': '{', ']': '[' };
  const opener = openFor[last]!;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i]!;
    if (ch === '}' || ch === ']') depth++;
    else if (ch === '{' || ch === '[') {
      depth--;
      if (depth === 0) {
        // Only treat this as a "trailing" block if it's at the start of
        // a line — otherwise we'd strip inline `{foo}` from prose.
        if (ch !== opener) return null;
        const before = trimmed.slice(0, i);
        if (before.length > 0 && !before.endsWith('\n') && !/\s$/.test(before)) {
          return null;
        }
        return { start: i, end: trimmed.length };
      }
    }
  }
  return null;
}

function sanitizeResearchPlan(obj: unknown): ResearchQueryProposal[] | null {
  if (!Array.isArray(obj)) return null;
  const out: ResearchQueryProposal[] = [];
  for (const item of obj) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const q = typeof rec.query === 'string' ? rec.query.trim() : '';
    if (!q) continue;
    const r = typeof rec.rationale === 'string' ? rec.rationale.trim() : '';
    out.push({ query: q, rationale: r });
  }
  return out;
}

export function parsePlannerReply(raw: string): ParsedPlannerReply {
  let chat = raw;
  let rubricPatch: Partial<DeepPlanRubric> | null = null;
  let researchPlan: ResearchQueryProposal[] | null = null;

  const rubricMatch = raw.match(RUBRIC_FENCE);
  if (rubricMatch) {
    const parsed = safeJson<unknown>(rubricMatch[1]!.trim());
    rubricPatch = sanitizeRubricPatch(parsed);
    chat = chat.replace(RUBRIC_FENCE, '');
  }

  const researchMatch = raw.match(RESEARCH_FENCE);
  if (researchMatch) {
    const parsed = safeJson<unknown>(researchMatch[1]!.trim());
    researchPlan = sanitizeResearchPlan(parsed);
    chat = chat.replace(RESEARCH_FENCE, '');
  }

  // Fallback for models that forget the fence and emit bare JSON at the
  // end of the reply (seen in the clarify stage). Strip it from the chat
  // regardless, and try to salvage a rubric patch if we don't already
  // have one.
  if (!rubricMatch && !researchMatch) {
    const trailing = findTrailingJsonBlock(chat);
    if (trailing) {
      const blob = chat.slice(trailing.start, trailing.end);
      const parsed = safeJson<unknown>(blob);
      if (parsed && !Array.isArray(parsed)) {
        rubricPatch = sanitizeRubricPatch(parsed);
      }
      chat = chat.slice(0, trailing.start);
    }
  }

  return { chat: chat.trim(), rubricPatch, researchPlan };
}

export function applyRubricPatch(
  current: DeepPlanRubric,
  patch: Partial<DeepPlanRubric>,
): DeepPlanRubric {
  return {
    title: patch.title !== undefined ? patch.title : current.title,
    form: patch.form !== undefined ? patch.form : current.form,
    audience: patch.audience !== undefined ? patch.audience : current.audience,
    lengthTarget: patch.lengthTarget !== undefined ? patch.lengthTarget : current.lengthTarget,
    thesis: patch.thesis !== undefined ? patch.thesis : current.thesis,
    mustCover: patch.mustCover !== undefined ? patch.mustCover : current.mustCover,
    mustAvoid: patch.mustAvoid !== undefined ? patch.mustAvoid : current.mustAvoid,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
  };
}
