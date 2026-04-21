import type {
  ChairOutput,
  ChairQuestion,
  ChairQuestionChoice,
  ChairQuestionType,
  DeepPlanRubric,
  PanelFinding,
  PanelOutput,
  PanelResearchRequest,
  PanelRole,
} from '@shared/types';

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

/**
 * Pull the first balanced JSON object / array out of a blob that may be
 * wrapped in ```json ... ``` fences, prose preamble, or trailing
 * commentary. The cheap panel models regularly emit exactly that despite
 * being told not to, so we accept it. Returns null if nothing parseable.
 */
function extractJsonBlob(raw: string): unknown | null {
  if (!raw) return null;
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]!.trim());
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    const direct = safeJson<unknown>(candidate);
    if (direct !== null) return direct;

    // Scan for the first balanced {...} or [...].
    for (const openCh of ['{', '[']) {
      const closeCh = openCh === '{' ? '}' : ']';
      const start = candidate.indexOf(openCh);
      if (start < 0) continue;
      let depth = 0;
      let inStr = false;
      let escape = false;
      for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i]!;
        if (escape) {
          escape = false;
          continue;
        }
        if (inStr) {
          if (ch === '\\') escape = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === openCh) depth++;
        else if (ch === closeCh) {
          depth--;
          if (depth === 0) {
            const blob = candidate.slice(start, i + 1);
            const parsed = safeJson<unknown>(blob);
            if (parsed !== null) return parsed;
            break;
          }
        }
      }
    }
  }
  return null;
}

function strOr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function sanitizePanelFinding(item: unknown): PanelFinding | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const claim = strOr(rec.claim);
  if (!claim) return null;
  const rawSeverity = strOr(rec.severity).toLowerCase();
  const severity: PanelFinding['severity'] =
    rawSeverity === 'high' || rawSeverity === 'low' ? rawSeverity : 'mid';
  return {
    severity,
    claim,
    rationale: strOr(rec.rationale),
    suggestedAction: strOr(rec.suggestedAction ?? rec.suggested_action),
  };
}

function sanitizePanelResearch(item: unknown): PanelResearchRequest | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const query = strOr(rec.query);
  if (!query) return null;
  return { query, rationale: strOr(rec.rationale) };
}

export function parsePanelOutput(raw: string, role: PanelRole): PanelOutput {
  const parsed = extractJsonBlob(raw);
  const findings: PanelFinding[] = [];
  const needsResearch: PanelResearchRequest[] = [];

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    if (Array.isArray(rec.findings)) {
      for (const item of rec.findings) {
        const f = sanitizePanelFinding(item);
        if (f) findings.push(f);
      }
    }
    const researchSource =
      (Array.isArray(rec.needsResearch) && rec.needsResearch) ||
      (Array.isArray(rec.needs_research) && rec.needs_research) ||
      null;
    if (researchSource) {
      for (const item of researchSource) {
        const r = sanitizePanelResearch(item);
        if (r) needsResearch.push(r);
      }
    }
  }

  // Cap defensively — the prompt says 4 findings / 3 queries but some
  // models ignore that.
  return {
    role,
    findings: findings.slice(0, 4),
    needsResearch: needsResearch.slice(0, 3),
  };
}

const VALID_QUESTION_TYPES: readonly ChairQuestionType[] = [
  'choice',
  'multi',
  'open',
  'confirm',
];

function sanitizeChoice(item: unknown, index: number): ChairQuestionChoice | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const label = strOr(rec.label);
  if (!label) return null;
  const id = strOr(rec.id) || `opt-${index + 1}`;
  return { id, label };
}

function sanitizeChairQuestion(item: unknown, index: number): ChairQuestion | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const prompt = strOr(rec.prompt);
  if (!prompt) return null;
  const rawType = strOr(rec.type).toLowerCase() as ChairQuestionType;
  const type: ChairQuestionType = VALID_QUESTION_TYPES.includes(rawType) ? rawType : 'open';
  const id = strOr(rec.id) || `q${index + 1}`;
  const rationale = strOr(rec.rationale) || undefined;

  let choices: ChairQuestionChoice[] | undefined;
  if (type === 'choice' || type === 'multi') {
    const rawChoices = Array.isArray(rec.choices) ? rec.choices : [];
    const parsed = rawChoices
      .map((c, i) => sanitizeChoice(c, i))
      .filter((c): c is ChairQuestionChoice => c !== null);
    if (parsed.length < 2) return null; // choice/multi must have options
    choices = parsed.slice(0, 5);
  } else if (type === 'confirm') {
    choices = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  }

  return { id, type, prompt, choices, rationale };
}

export function parseChairOutput(raw: string): ChairOutput | null {
  const parsed = extractJsonBlob(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;

  const summary = strOr(rec.summary);
  if (!summary) return null;

  const rawQuestions = Array.isArray(rec.questions) ? rec.questions : [];
  const questions: ChairQuestion[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = sanitizeChairQuestion(rawQuestions[i], i);
    if (q) questions.push(q);
  }

  const phaseAdvance =
    rec.phaseAdvance === true || rec.phase_advance === true;

  let rubricPatch: Partial<DeepPlanRubric> | undefined;
  const patchCandidate = rec.rubricPatch ?? rec.rubric_patch;
  if (patchCandidate && typeof patchCandidate === 'object') {
    const sanitized = sanitizeRubricPatch(patchCandidate);
    if (sanitized) rubricPatch = sanitized;
  }

  return {
    summary,
    questions: questions.slice(0, 5),
    phaseAdvance,
    rubricPatch,
  };
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
