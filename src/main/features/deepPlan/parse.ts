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

function sanitizeRubricPatch(obj: unknown): Partial<DeepPlanRubric> | null {
  if (!obj || typeof obj !== 'object') return null;
  const src = obj as Record<string, unknown>;
  const out: Partial<DeepPlanRubric> = {};
  const strKeys = ['title', 'form', 'audience', 'lengthTarget', 'thesis', 'notes'] as const;
  for (const k of strKeys) {
    const v = src[k];
    if (typeof v === 'string') {
      (out as Record<string, unknown>)[k] = v;
    } else if (v === null) {
      (out as Record<string, unknown>)[k] = null;
    }
  }
  if (Array.isArray(src.mustCover)) {
    out.mustCover = src.mustCover.filter((x): x is string => typeof x === 'string');
  }
  if (Array.isArray(src.mustAvoid)) {
    out.mustAvoid = src.mustAvoid.filter((x): x is string => typeof x === 'string');
  }
  return Object.keys(out).length > 0 ? out : null;
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
