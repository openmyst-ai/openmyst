import type {
  ChairOutput,
  ChairQuestion,
  ChairQuestionChoice,
  ChairQuestionType,
  PanelOutput,
  PanelResearchRequest,
  PanelRole,
  PlanRequirements,
} from '@shared/types';

/**
 * Tolerant parsers for the structured outputs the panel + Chair emit.
 * Cheap panelist models sometimes wrap JSON in fenced blocks, add prose
 * preamble, or use snake_case despite being told not to — we accept all
 * of that rather than re-prompting.
 *
 * Also exported: `parseResearchPlan`, a narrow parser that only pulls a
 * `research_plan` fence out of a Deep Search planner reply. Deep Search
 * uses its own prompt; this helper is all it needs now that Deep Plan
 * no longer emits chat-style planner replies.
 */

export interface ResearchQueryProposal {
  query: string;
  rationale: string;
}

const RESEARCH_FENCE = /```\s*research_plan\s*\n([\s\S]*?)```/i;

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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

/**
 * Narrow parser for Deep Search — extract the `research_plan` fence, return
 * its array if present, else null. No rubric, no chat stripping.
 */
export function parseResearchPlan(raw: string): ResearchQueryProposal[] | null {
  const match = raw.match(RESEARCH_FENCE);
  if (!match) return null;
  return sanitizeResearchPlan(safeJson<unknown>(match[1]!.trim()));
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

function sanitizePanelResearch(item: unknown): PanelResearchRequest | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const query = strOr(rec.query);
  if (!query) return null;
  return { query, rationale: strOr(rec.rationale) };
}

/**
 * A panelist's anchor proposal is a plain `slug#anchor-id` string. Models
 * sometimes dress it up ({id: "slug#x"}, {anchor: "..."}, etc.); we
 * accept any of those shapes and extract the string.
 */
function sanitizeAnchorProposal(item: unknown): string | null {
  if (typeof item === 'string') {
    const s = item.trim();
    return s && s.includes('#') ? s : null;
  }
  if (item && typeof item === 'object') {
    const rec = item as Record<string, unknown>;
    for (const k of ['id', 'anchor', 'anchorId', 'anchor_id']) {
      const v = rec[k];
      if (typeof v === 'string' && v.trim().includes('#')) return v.trim();
    }
  }
  return null;
}

export function parsePanelOutput(raw: string, role: PanelRole): PanelOutput {
  const parsed = extractJsonBlob(raw);
  const anchorProposals: string[] = [];
  const needsResearch: PanelResearchRequest[] = [];
  let visionNotes = '';

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const proposalSource =
      (Array.isArray(rec.anchorProposals) && rec.anchorProposals) ||
      (Array.isArray(rec.anchor_proposals) && rec.anchor_proposals) ||
      (Array.isArray(rec.anchors) && rec.anchors) ||
      null;
    if (proposalSource) {
      const seen = new Set<string>();
      for (const item of proposalSource) {
        const p = sanitizeAnchorProposal(item);
        if (p && !seen.has(p)) {
          seen.add(p);
          anchorProposals.push(p);
        }
      }
    }
    visionNotes = strOr(rec.visionNotes ?? rec.vision_notes);
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

  // Caps: 3 anchors per role per round keeps the log growing at a
  // manageable pace (panel has 3–4 roles per phase × multiple rounds).
  // Research is expensive, so 2 queries per role is a hard ceiling.
  return {
    role,
    anchorProposals: anchorProposals.slice(0, 3),
    visionNotes: visionNotes.slice(0, 500),
    needsResearch: needsResearch.slice(0, 2),
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
  const recommended = rec.recommended === true;
  return recommended ? { id, label, recommended } : { id, label };
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
  const allowCustom = rec.allowCustom === true || rec.allow_custom === true;

  let choices: ChairQuestionChoice[] | undefined;
  if (type === 'choice' || type === 'multi') {
    const rawChoices = Array.isArray(rec.choices) ? rec.choices : [];
    const parsed = rawChoices
      .map((c, i) => sanitizeChoice(c, i))
      .filter((c): c is ChairQuestionChoice => c !== null);
    if (parsed.length < 2) return null;
    choices = parsed.slice(0, 5);
    // At most one recommended choice per question. If the model marked
    // multiple, keep the first and demote the rest.
    let seen = false;
    choices = choices.map((c) => {
      if (!c.recommended) return c;
      if (seen) return { id: c.id, label: c.label };
      seen = true;
      return c;
    });
  } else if (type === 'confirm') {
    choices = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  }

  const out: ChairQuestion = { id, type, prompt, choices, rationale };
  if (allowCustom && type === 'choice') out.allowCustom = true;
  return out;
}

/**
 * Tolerantly pull a requirements patch out of the Chair's JSON. Accepts
 * any subset of the four fields; tolerates snake_case aliases; returns
 * null when nothing usable was present (so the caller doesn't overwrite
 * existing requirements with empty data).
 */
/**
 * Tolerantly pull the Chair's anchor-log additions. Each element can be a
 * plain `slug#anchor-id` string or a `{id, note}` object. Returns an
 * empty array rather than null — downstream code always treats it as a
 * list to append.
 */
function sanitizeAnchorLogAdd(raw: unknown): { id: string; note?: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; note?: string }[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id.includes('#') && !seen.has(id)) {
        seen.add(id);
        out.push({ id });
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawId = rec.id ?? rec.anchor ?? rec.anchorId ?? rec.anchor_id;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id.includes('#') || seen.has(id)) continue;
    seen.add(id);
    const noteRaw = rec.note;
    const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';
    out.push(note ? { id, note } : { id });
  }
  return out;
}

function sanitizeRequirementsPatch(item: unknown): Partial<PlanRequirements> | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const patch: Partial<PlanRequirements> = {};
  const minRaw = rec.wordCountMin ?? rec.word_count_min;
  const maxRaw = rec.wordCountMax ?? rec.word_count_max;
  if (typeof minRaw === 'number' && Number.isFinite(minRaw)) patch.wordCountMin = Math.round(minRaw);
  if (typeof maxRaw === 'number' && Number.isFinite(maxRaw)) patch.wordCountMax = Math.round(maxRaw);
  const form = typeof rec.form === 'string' ? rec.form.trim() : '';
  if (form) patch.form = form;
  const audience = typeof rec.audience === 'string' ? rec.audience.trim() : '';
  if (audience) patch.audience = audience;
  const notes = typeof (rec.styleNotes ?? rec.style_notes) === 'string'
    ? String(rec.styleNotes ?? rec.style_notes).trim()
    : '';
  if (notes) patch.styleNotes = notes;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function parseChairOutput(raw: string): ChairOutput | null {
  const parsed = extractJsonBlob(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;

  const summary = strOr(rec.summary);
  if (!summary) return null;

  // visionUpdate: string when the Chair wants a full new vision, null when
  // it wants to keep the prior vision. Empty strings are coerced to null
  // (empty vision is never intentional — it'd mean "wipe everything",
  // which we don't allow from a single round).
  const rawVision = rec.visionUpdate ?? rec.vision_update ?? rec.vision;
  let visionUpdate: string | null = null;
  if (typeof rawVision === 'string' && rawVision.trim().length > 0) {
    visionUpdate = rawVision;
  }

  const anchorLogAdd = sanitizeAnchorLogAdd(
    rec.anchorLogAdd ?? rec.anchor_log_add ?? rec.anchorAdditions ?? rec.anchors,
  );

  const rawQuestions = Array.isArray(rec.questions) ? rec.questions : [];
  const questions: ChairQuestion[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = sanitizeChairQuestion(rawQuestions[i], i);
    if (q) questions.push(q);
  }

  const phaseAdvance =
    rec.phaseAdvance === true || rec.phase_advance === true;

  const requirementsPatch = sanitizeRequirementsPatch(
    rec.requirementsPatch ?? rec.requirements_patch,
  );

  return {
    summary,
    visionUpdate,
    anchorLogAdd,
    questions: questions.slice(0, 3),
    phaseAdvance,
    requirementsPatch,
  };
}
