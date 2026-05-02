import type {
  ChairOutput,
  ChairQuestion,
  ChairQuestionChoice,
  ChairQuestionType,
  PanelOutput,
  PanelResearchRequest,
  PanelRole,
  PanelUserPrompt,
  PanelUserPromptKind,
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

const VALID_PROMPT_KINDS: readonly PanelUserPromptKind[] = [
  'concern',
  'question',
  'clarification',
  'idea',
];

function sanitizeUserPrompt(item: unknown): PanelUserPrompt | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  const prompt = strOr(rec.prompt);
  if (!prompt) return null;
  const kindRaw = strOr(rec.kind).toLowerCase() as PanelUserPromptKind;
  const kind: PanelUserPromptKind = VALID_PROMPT_KINDS.includes(kindRaw) ? kindRaw : 'question';
  const rationale = strOr(rec.rationale);
  const out: PanelUserPrompt = { kind, prompt, rationale };
  const delegableQuery = strOr(rec.delegableQuery ?? rec.delegable_query ?? rec.query);
  if (delegableQuery) out.delegableQuery = delegableQuery;
  return out;
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
  const userPrompts: PanelUserPrompt[] = [];
  const needsResearch: PanelResearchRequest[] = [];
  let visionNotes = '';

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    visionNotes = strOr(rec.visionNotes ?? rec.vision_notes);
    const promptSource =
      (Array.isArray(rec.userPrompts) && rec.userPrompts) ||
      (Array.isArray(rec.user_prompts) && rec.user_prompts) ||
      null;
    if (promptSource) {
      for (const item of promptSource) {
        const p = sanitizeUserPrompt(item);
        if (p) userPrompts.push(p);
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

  // Sanity backstops — the panelist prompt sets the real targets and
  // teaches the model when to push higher / lower. Cap auto-search HARD
  // at 1 per panelist: the panel runs in parallel, so a 1-each cap keeps
  // total round volume to ~one-per-panelist worst case (most should
  // emit 0 anyway). User-prompts get more headroom since they cost
  // nothing — Chair curates them down to 2–3 surfaced.
  return {
    role,
    visionNotes: visionNotes.slice(0, 500),
    userPrompts: userPrompts.slice(0, 3),
    needsResearch: needsResearch.slice(0, 1),
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
  const delegableQuery = strOr(rec.delegableQuery ?? rec.delegable_query);
  if (delegableQuery) out.delegableQuery = delegableQuery;
  const proposedByRaw = strOr(rec.proposedBy ?? rec.proposed_by).toLowerCase();
  if (proposedByRaw) {
    const validRoles: readonly string[] = [
      'explorer', 'scoper', 'stakes', 'architect', 'evidence',
      'steelman', 'skeptic', 'adversary', 'editor', 'audience', 'finaliser',
      'chair',
    ];
    if (validRoles.includes(proposedByRaw)) {
      out.proposedBy = proposedByRaw as ChairQuestion['proposedBy'];
    }
  }
  return out;
}

/**
 * Tolerantly pull a requirements patch out of the Chair's JSON. Accepts
 * any subset of the four fields; tolerates snake_case aliases; returns
 * null when nothing usable was present (so the caller doesn't overwrite
 * existing requirements with empty data).
 */
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
  const framework = typeof rec.framework === 'string' ? rec.framework.trim() : '';
  if (framework) patch.framework = framework;
  const deliverableRaw =
    rec.deliverableFormat ?? rec.deliverable_format ?? rec.deliverable;
  const deliverable = typeof deliverableRaw === 'string' ? deliverableRaw.trim() : '';
  if (deliverable) patch.deliverableFormat = deliverable;
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
    questions: questions.slice(0, 6),
    phaseAdvance,
    requirementsPatch,
  };
}
