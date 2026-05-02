export interface AppSettings {
  defaultModel: string;
  hasOpenRouterKey: boolean;
  hasJinaKey: boolean;
  /**
   * Deprecated — Deep Plan now splits this into `chairModel` + `draftModel`.
   * Kept for backward compatibility: callers reading this get `chairModel`
   * so older UI still works while we migrate it.
   */
  deepPlanModel: string;
  /** Strong model used by the Chair and the Chair-chat path. */
  chairModel: string;
  /** Model used by the one-shot drafter at Deep Plan → draft handoff. */
  draftModel: string;
  /** Cheap model used by the Deep Plan panel roles each round. */
  panelModel: string;
  /** Cheap model used for source-ingest digest + anchor extraction. */
  summaryModel: string;
  recentProjects: string[];
  /**
   * Folder under which the user keeps all their Open Myst projects. Each
   * project is a subdirectory with a `project.json` marker. `null` until
   * the user picks one (or accepts the default) on first launch.
   */
  workspaceRoot: string | null;
  /** Suggested workspace root if `workspaceRoot` is null (e.g. ~/Documents/OpenMyst). */
  defaultWorkspaceRoot: string;
}

/**
 * Lightweight summary of a project found inside the workspace root, used
 * to render the project gallery on the Welcome screen.
 */
export interface WorkspaceProject {
  /** Display name from project.json — falls back to folder basename. */
  name: string;
  /** Absolute path to the project root. */
  path: string;
  /** ISO timestamp from project.json, or folder mtime if missing. */
  createdAt: string;
  /** Most recent file mtime inside the project, for "last opened" sort. */
  updatedAt: string;
}

/**
 * The curated list of models users can pick from in Settings. A single
 * selection drives both chat and Deep Plan/Search — keeps cost predictable
 * and avoids asking launch users to reason about two knobs.
 */
export const MODEL_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
  { id: 'qwen/qwen3.5-flash-02-23', label: 'Qwen 3.5 Flash' },
];

/**
 * Research-summary model options. Digest is a bounded "produce JSON with
 * name/summary/indexSummary/anchors[]" task where anchors contain verbatim
 * source spans. Sub-15B models (e.g. Mistral Nemo) frequently fail to
 * produce valid JSON on this prompt — when parsing fails we silently fall
 * back to the first 500 chars of the raw source as the "summary", which
 * looks like a bug to the user. Default to a model proven to be fast AND
 * reliable at structured output.
 */
export const SUMMARY_MODEL_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (fast, reliable)' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
  { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
  { id: 'qwen/qwen3.5-flash-02-23', label: 'Qwen 3.5 Flash' },
  { id: 'mistralai/mistral-nemo', label: 'Mistral Nemo (fastest — JSON output unreliable)' },
];

/**
 * Default model across chat, Chair, drafter, panel. Gemma-4-31b-it is
 * punchy: strong structured-output compliance, good general-purpose
 * reasoning, cheap enough to fan out the panel on. Only the source-digest
 * slot diverges (see DEFAULT_SUMMARY_MODEL) because that's a one-shot
 * per-source task where the cheapest reliable model wins.
 */
export const DEFAULT_DEEP_PLAN_MODEL = 'google/gemma-4-31b-it';
export const DEFAULT_SUMMARY_MODEL = 'google/gemini-2.5-flash-lite';
export const DEFAULT_CHAIR_MODEL = 'google/gemma-4-31b-it';
export const DEFAULT_DRAFT_MODEL = 'google/gemma-4-31b-it';
export const DEFAULT_PANEL_MODEL = 'google/gemma-4-31b-it';

export interface ProjectMeta {
  name: string;
  path: string;
  defaultModel: string | null;
  createdAt: string;
}

export interface ProjectSummary {
  path: string;
  name: string;
}

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const DEFAULT_MODEL = 'google/gemma-4-31b-it';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
}

export interface Heading {
  level: number;
  text: string;
  pos: number;
}

/**
 * `raw` — a file we keep verbatim on disk and never summarise (code, CSVs,
 * JSON, etc.). The agent reads them on demand via `source_lookup` with
 * `raw: true`.
 * `link` — a URL we fetched as markdown via Jina Reader, then summarised
 * through the normal pipeline. Behaves identically to `pasted` except the
 * origin is a live URL stored in `sourcePath`.
 */
/**
 * How the drafter should treat this source.
 * - `reference` (default): evidence to cite. Inline anchor citations + entry
 *   in the References section.
 * - `guidance`: method/framework/style guide. The drafter INTERNALISES its
 *   instructions but does NOT cite it inline or list it in References. Used
 *   for things like "How to write a literature review" or "CRAAP test
 *   handout" — process material, not content.
 */
export type SourceRole = 'reference' | 'guidance';

/**
 * Best-effort bibliographic metadata extracted at ingest time. Populated by
 * the digest LLM from the source's title page / header / URL. Drafter uses
 * `(author, year)` style citations whenever this is populated; falls back
 * to source name when fields are missing.
 */
export interface SourceBibliographic {
  /** Surname-only or institutional name. e.g. "Sen", "Stanford Encyclopedia of Philosophy". */
  author?: string;
  /** 4-digit publication year if recoverable. e.g. 1970. */
  year?: number;
  /** Source title in original capitalisation. */
  title?: string;
  /** Journal / outlet / publisher. e.g. "Journal of Political Economy". */
  journal?: string;
  /** Bare DOI without leading "https://doi.org/". */
  doi?: string;
  /** Canonical URL where the source lives, when known. */
  url?: string;
}

export interface SourceMeta {
  slug: string;
  name: string;
  originalName: string;
  type: 'pdf' | 'markdown' | 'text' | 'pasted' | 'raw' | 'link';
  addedAt: string;
  summary: string;
  indexSummary: string;
  sourcePath?: string;
  anchors?: SourceAnchorSummary[];
  /** Relative filename (under `sources/`) where the verbatim file lives — raw sources only. */
  rawFile?: string;
  /** Byte size of the underlying file — raw sources only, for UI + caps. */
  sizeBytes?: number;
  /** Defaults to `'reference'` when omitted (older ingests, raw sources). */
  role?: SourceRole;
  bibliographic?: SourceBibliographic;
}

/**
 * Typed buckets the anchor extractor emits. The first five are the
 * phase-2+ canonical set: every claim in plan.md has to land in one of
 * these. The rest are legacy labels carried by older ingests — we still
 * accept them on read so existing wikis keep working, but new extractions
 * should only use the canonical five.
 */
export type SourceAnchorType =
  | 'definition'
  | 'claim'
  | 'statistic'
  | 'quote'
  | 'finding'
  // Legacy — still readable, no longer emitted by the extractor.
  | 'rule'
  | 'argument'
  | 'idea'
  | 'equation'
  | 'section';

export interface SourceAnchorSummary {
  id: string;
  type: SourceAnchorType;
  label: string;
}

export interface SourceAnchor extends SourceAnchorSummary {
  keywords: string[];
  charStart: number;
  charEnd: number;
  /**
   * The verbatim passage this anchor points to, stored at index time so
   * callers never need to re-read <slug>.raw.txt. Older indexes (pre-v2)
   * may not have this field; `readAnchor` falls back to slicing the raw
   * file by charStart/charEnd when it's missing.
   */
  text?: string;
}

export interface SourceIndex {
  version: 1;
  anchors: SourceAnchor[];
}

export interface DocumentFile {
  filename: string;
  label: string;
}

export interface Comment {
  id: string;
  docFilename: string;
  text: string;
  contextBefore: string;
  contextAfter: string;
  message: string;
  createdAt: string;
}

export interface PendingEdit {
  id: string;
  docFilename: string;
  oldString: string;
  newString: string;
  occurrence: number;
  createdAt: string;
  batchId: string;
  batchIndex: number;
  batchTotal: number;
}

export interface WikiGraphNode {
  id: string;
  name: string;
  indexSummary: string;
  addedAt: string;
}

export interface WikiGraphEdge {
  source: string;
  target: string;
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
}

/**
 * Deep Plan is now a three-phase loop driven by an adversarial panel of
 * cheap-model agents and a strong-model Chair that synthesises their
 * findings into structured questions for the user. Each phase runs the
 * same inner loop (panel → research-if-needed → chair → user answers)
 * until the Chair signals `phaseAdvance` or the user forces it.
 */
/**
 * The kind of research deliverable the user is making. Picked upfront on
 * Deep Plan start; drives the Chair's vision template, the drafter's
 * output structure, and (eventually) the panel's role mix. The point of
 * an explicit mode is that "I have a half-baked idea" should NOT produce
 * an essay defending the idea as if established — different deliverables
 * want different shapes from the panel and the drafter.
 *
 * Modes:
 * - `argumentative-essay` — Defend a thesis with cited evidence. The
 *   default, the legacy behaviour. Best when the user knows what they
 *   want to argue and needs help arguing it.
 * - `idea-exploration` — Pressure-test a half-baked concept. Drafter
 *   does NOT manufacture a thesis; instead surveys prior art, evaluates
 *   strengths/weaknesses, and proposes concrete directions. Output reads
 *   as a conceptual workshop, not an essay.
 * - `literature-review` — Survey + synthesis across sources. Per-source
 *   sections (Article 1, Article 2, …) each with intro/summary/analysis,
 *   followed by a final synthesis comparing them.
 * - `analytical-report` — User has data/observations + sources, wants a
 *   structured findings document. Methods → Findings → Discussion.
 *   Reads raw-source files (CSV/JSON/code) when available.
 * - `comparative-analysis` — Compare 2+ things across criteria. Drafter
 *   structures by criterion or by subject.
 */
export type DeepPlanMode =
  | 'argumentative-essay'
  | 'idea-exploration'
  | 'literature-review'
  | 'analytical-report'
  | 'comparative-analysis';

export const DEEP_PLAN_MODES: DeepPlanMode[] = [
  'argumentative-essay',
  'idea-exploration',
  'literature-review',
  'analytical-report',
  'comparative-analysis',
];

export interface DeepPlanModeConfig {
  id: DeepPlanMode;
  /** Short label for the mode picker card. */
  label: string;
  /** One-line description shown under the label. */
  blurb: string;
  /** Placeholder text for the brief textarea, tailored to the mode. */
  briefPlaceholder: string;
}

export const DEEP_PLAN_MODE_CONFIGS: Record<DeepPlanMode, DeepPlanModeConfig> = {
  'argumentative-essay': {
    id: 'argumentative-essay',
    label: 'Argumentative essay',
    blurb: 'Defend a thesis with cited evidence. The classic essay shape.',
    briefPlaceholder:
      'e.g. A 2000-word essay arguing that minimum wages distort labour markets less than common claims suggest, for an econ-curious general audience…',
  },
  'idea-exploration': {
    id: 'idea-exploration',
    label: 'Idea exploration',
    blurb:
      'Pressure-test a half-baked concept. Find prior art, weigh strengths/weaknesses, surface concrete directions.',
    briefPlaceholder:
      'e.g. I have a concept I call RLVT — using a judge LLM to audit reasoning chains rather than just score them. Find prior art, stress-test the idea, and tell me where it could go.',
  },
  'literature-review': {
    id: 'literature-review',
    label: 'Literature review',
    blurb: 'Survey + synthesise existing work across multiple sources.',
    briefPlaceholder:
      'e.g. A 1200-word literature review of fish welfare assessment methods in aquaculture, evaluating two articles for a vet-science assignment…',
  },
  'analytical-report': {
    id: 'analytical-report',
    label: 'Analytical report',
    blurb:
      'Data/observations + sources → structured findings. Methods → Findings → Discussion.',
    briefPlaceholder:
      'e.g. An analytical report on the survey data I uploaded, situating the findings in the literature on remote-work productivity…',
  },
  'comparative-analysis': {
    id: 'comparative-analysis',
    label: 'Comparative analysis',
    blurb: 'Compare 2+ things across explicit criteria, evidence-grounded.',
    briefPlaceholder:
      'e.g. A comparative analysis of three constitutional approaches to free-speech regulation, judged on consistency, scope, and enforcement…',
  },
};

export type DeepPlanPhase = 'ideation' | 'planning' | 'reviewing' | 'done';

export const DEEP_PLAN_PHASE_ORDER: DeepPlanPhase[] = [
  'ideation',
  'planning',
  'reviewing',
  'done',
];

/**
 * Cheap-model panelist roles, grouped by the phase where each is
 * activated. A role is a narrow adversarial lens — one call per role per
 * round, all fanned out in parallel.
 */
export type PanelRole =
  | 'explorer'
  | 'scoper'
  | 'stakes'
  | 'architect'
  | 'evidence'
  | 'steelman'
  | 'skeptic'
  | 'adversary'
  | 'editor'
  | 'audience'
  | 'finaliser';

export const PANEL_ROLES_BY_PHASE: Record<DeepPlanPhase, PanelRole[]> = {
  ideation: ['explorer', 'scoper', 'stakes'],
  planning: ['architect', 'evidence', 'steelman', 'skeptic'],
  reviewing: ['adversary', 'editor', 'audience', 'finaliser'],
  done: [],
};

export interface PanelResearchRequest {
  query: string;
  rationale: string;
}

/**
 * Categorisation of the things a panelist wants to put in front of the user.
 * Drives the small UI tag rendered above each prompt so the user sees at a
 * glance what kind of input is being asked for.
 */
export type PanelUserPromptKind = 'concern' | 'question' | 'clarification' | 'idea';

/**
 * Something the panelist wants the user to weigh in on — concern, question,
 * clarification, or idea. Replaces the old "panel autonomously fires search"
 * loop: when a panelist would have searched, it now ASKS first, attaching
 * the proposed query as a `delegableQuery`. The Chair selects the strongest
 * prompts to surface, and the user either steers (vision sharpened) or
 * delegates (search dispatches before next round).
 */
export interface PanelUserPrompt {
  kind: PanelUserPromptKind;
  /** The prompt as the user will see it — one clear sentence ideally. */
  prompt: string;
  /** One-line context — why the panelist is raising this. */
  rationale: string;
  /**
   * Optional research query to fire iff the user delegates. Phrased as a
   * standalone search query, not a sentence. e.g. "RLVT verifiable reasoning
   * judge LLM prior art".
   */
  delegableQuery?: string;
}

/**
 * Panel output. Each panelist contributes three lanes:
 *
 * - `visionNotes` — private synthesis input for the Chair.
 * - `needsResearch[]` — searches the panelist is CONFIDENT need to fire
 *   regardless of user input (clear wiki coverage gap). Auto-dispatched
 *   by `runPanelRound` against the session's search budget. Use sparingly
 *   — every fired search costs latency and pollutes the wiki if the
 *   results are weak.
 * - `userPrompts[]` — concerns / questions / clarifications / ideas to
 *   put in front of the writer. Optionally carry a `delegableQuery`
 *   that fires ONLY if the user picks "research this". This is the
 *   probing lane: "have you considered X?", "want me to look this up?".
 */
export interface PanelOutput {
  role: PanelRole;
  /** Short free-text: what's missing or off about the vision. ≤ 2 sentences. */
  visionNotes: string;
  /**
   * Auto-dispatched search queries. Capped per panelist + per round in
   * the prompt; merged + deduped across panelists at dispatch time.
   */
  needsResearch: PanelResearchRequest[];
  /**
   * Concerns / questions / clarifications / ideas this panelist wants in
   * front of the user. Capped per panelist in the prompt; Chair selects
   * the strongest few to surface as ChairQuestions.
   */
  userPrompts: PanelUserPrompt[];
}

export type ChairQuestionType = 'choice' | 'multi' | 'open' | 'confirm';

export interface ChairQuestionChoice {
  id: string;
  label: string;
  /**
   * When true, this is the Chair's gentle suggestion — what a thoughtful
   * panel would pick on the user's behalf if they delegated. At most one
   * choice per question should be recommended.
   */
  recommended?: boolean;
}

export interface ChairQuestion {
  id: string;
  type: ChairQuestionType;
  prompt: string;
  /** Present only for `choice` and `multi`. */
  choices?: ChairQuestionChoice[];
  /** Optional one-line "why this matters" shown under the prompt. */
  rationale?: string;
  /**
   * When true (on a `choice` question), the UI offers a "Write my own"
   * path alongside the listed options — user can take the Chair's options
   * or type a freeform answer. Defaults off.
   */
  allowCustom?: boolean;
  /**
   * Who proposed this question. `'chair'` for Chair-originated questions
   * (rubric gaps, judgment forks). A `PanelRole` when the Chair surfaced
   * a panelist's prompt. UI uses this to show "Skeptic asks…" attribution
   * — concrete provenance instead of a faceless committee.
   */
  proposedBy?: PanelRole | 'chair';
  /**
   * Optional research query attached to this question. When the user picks
   * the "research this" option, the orchestrator dispatches the query
   * before the next panel round. Lets a panelist propose a search without
   * firing it autonomously — search is always user-blessed.
   */
  delegableQuery?: string;
}

/**
 * User's response to a single Chair question. `null` means skipped.
 * `string` covers `choice` (choice id), `open` (free text), and
 * `confirm` (`"yes"` / `"no"`). `string[]` covers `multi`.
 */
export type ChairAnswer = string | string[] | null;

export type ChairAnswerMap = Record<string, ChairAnswer>;

/**
 * Chair's structured output for a round. The Chair rewrites `plan` in
 * full every round — plan.md is the living artefact the panel is
 * refining, and it's cheaper to regenerate than to diff. `summary` is
 * the short chat bubble explaining what changed and why. `questions` is
 * the Question Card carousel (1–3 items, only when a genuine judgment
 * call needs the user). `phaseAdvance: true` means the Chair thinks
 * this phase is done — the UI nudges the user toward Continue.
 */
/**
 * Chair's structured output. The Chair no longer curates the anchor log
 * — panel proposals are auto-resolved + appended before the Chair runs,
 * and the Chair just sees the resulting new entries as context for its
 * summary + vision update. This keeps the Chair's output tight and
 * removes the "is the Chair under-picking?" failure mode entirely.
 *
 * - `summary`: the short chat reply the user sees.
 * - `visionUpdate`: the FULL new vision.md when the Chair actually wants
 *   to change it. `null` to keep the prior vision unchanged (most rounds).
 * - `questions`: Chair's probes for the user.
 * - `phaseAdvance`: convergence signal.
 * - `requirementsPatch`: changes to the rubric (word count, form, etc.)
 *   when the user just answered a question about a hard requirement.
 */
export interface ChairOutput {
  summary: string;
  visionUpdate: string | null;
  questions: ChairQuestion[];
  phaseAdvance: boolean;
  requirementsPatch?: Partial<PlanRequirements> | null;
}

/**
 * One anchor, enriched with its source metadata. Populated deterministically
 * from the union of every ingested source's `<slug>.index.json` — no
 * curation, no session-side log. UI renders these, drafter consumes them.
 */
export interface AnchorLogEntry {
  /** `slug#anchor-id` — the canonical key. Matches the citation href fragment. */
  id: string;
  slug: string;
  sourceName: string;
  sourceUrl?: string;
  type: SourceAnchorType;
  /** Verbatim passage from the source. 1–4 sentences. */
  text: string;
  keywords: string[];
  /** Inherits from the source's role. `'reference'` when omitted. */
  role?: SourceRole;
  /** Inherits from the source's bibliographic metadata when populated. */
  bibliographic?: SourceBibliographic;
}

/**
 * Live progress events broadcast while a panel round is running, so the
 * UI can show "Explorer thinking… Scoper done (2 findings)" style
 * indicators. Each round has a start, per-role start/done events,
 * research dispatch, chair start/done, and a final round-done.
 */
export type PanelProgressEvent =
  | { kind: 'round-start'; phase: DeepPlanPhase; roles: PanelRole[] }
  | { kind: 'role-start'; role: PanelRole }
  | {
      kind: 'role-done';
      role: PanelRole;
      findings: number;
      searchQueries: number;
      /** The vision-note text the role emitted this round (empty string when silent). Streamed to the UI so users see the thought live. */
      visionNotes: string;
      /** Any research queries the role asked for this round — same order the parser produced. */
      needsResearch: PanelResearchRequest[];
      /** User-prompts the panelist proposed (concerns/questions/clarifications/ideas). Streamed live so the user sees what was raised before the Chair selects. */
      userPrompts: PanelUserPrompt[];
    }
  | { kind: 'role-failed'; role: PanelRole; error: string }
  | { kind: 'research-dispatched'; queries: number }
  | { kind: 'chair-start' }
  | { kind: 'chair-done' }
  | { kind: 'round-done' };

/**
 * Hard constraints extracted from the user's root task. These are
 * re-injected verbatim into every panel, chair, and drafter prompt so
 * the constraints don't rot as context grows. Everything here is
 * structured — freeform additions live in the plan.md itself.
 */
export interface PlanRequirements {
  /** Lower bound on word count if the task specified one (e.g. "1500"). */
  wordCountMin: number | null;
  /** Upper bound on word count if the task specified one (e.g. "2500"). */
  wordCountMax: number | null;
  /** Form label if mentioned — "essay", "blog post", "report", etc. */
  form: string | null;
  /** Audience label if mentioned. */
  audience: string | null;
  /** Any other hard constraints the user stated verbatim, for the panel to honour. */
  styleNotes: string | null;
  /**
   * Named framework / method / theoretical lens the user explicitly asked for
   * — "Five Domains", "CRAAP test", "BLUF", "STAR method". When present, the
   * drafter must APPLY the framework as the analytical lens, not write
   * about it. Stays null when the task didn't name one.
   */
  framework: string | null;
  /**
   * Specific deliverable format when the user named one beyond the simple
   * `form` (essay/report/blog). e.g. "literature review", "lab report",
   * "policy memo", "case study analysis". Drafter uses this to pick
   * structural conventions (lit review wants Article 1 / Article 2 sections
   * with intro/summary/analysis/conclusion; lab report wants method/results
   * /discussion; etc.). Null when the user only named the basic form.
   */
  deliverableFormat: string | null;
}

/**
 * Magic answer value used by `ChairAnswerMap` when the user picks the
 * "research this" option on a question with a `delegableQuery`. The
 * orchestrator scans answers for this sentinel after `submitAnswers` and
 * dispatches the matching queries through the research engine before the
 * next panel round runs.
 */
export const DELEGATE_TO_RESEARCH = '__research__';

/** Session-wide research query budget, across all phases combined. */
export const DEEP_PLAN_MAX_TOTAL_SEARCHES = 20;

/**
 * Soft target for auto-dispatched panel searches per round. ~1 across
 * the whole panel on typical depth, scaling up to 2–3 for genuinely
 * novel / under-grounded topics. Each round should fire SOMETHING when
 * the topic warrants — see the panelist prompt for the rule against
 * suppressing later rounds because "the wiki already has sources".
 * Search is per-claim, not per-session.
 */
export const DEEP_PLAN_TARGET_SEARCHES_PER_ROUND = 1;

/**
 * Soft target for Chair questions per round. The Chair scales UP when
 * the topic is ambiguous (multiple interpretations, scope under-defined,
 * the writer is still discovering what they mean) and DOWN when the
 * topic is clear and the writer's hand is firm. Used as a target —
 * not a hard cap. Empty rounds (0 questions) are fine once requirements
 * are pinned and nothing genuinely forks.
 */
export const DEEP_PLAN_TARGET_QUESTIONS_PER_ROUND = 2;

/**
 * Soft round limit per phase — once reached, the Chair is strongly
 * nudged toward `phaseAdvance: true` and asks the user if they'd like
 * to move on rather than opening a new round of questions. Previously 2,
 * bumped to 3 so ideation gets a genuine chance to dig — two rounds was
 * shallow in practice (a vague thesis would advance without the panel
 * surfacing audience/scope/word-count tensions hard enough).
 */
export const DEEP_PLAN_SOFT_ROUND_LIMIT_PER_PHASE = 3;

export interface DeepPlanMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  kind:
    | 'chat'
    | 'chair-turn'
    | 'user-answers'
    | 'phase-transition'
    /** User free-chat turn — cheap conversational exchange with the Chair, no panel. */
    | 'user-chat'
    /** Chair's reply during free-chat. Not a round summary; no plan rewrite. */
    | 'chair-chat';
  timestamp: string;
  /** Populated when `kind === 'chair-turn'`. */
  chair?: ChairOutput;
  /** Populated when `kind === 'user-answers'`. */
  answers?: ChairAnswerMap;
  /**
   * Per-role panel outputs from the round this chair-turn synthesised.
   * The UI surfaces these as a collapsible "Panel discussion" accordion
   * under the Chair's summary so the session isn't a black box — users
   * can see what each role actually contributed.
   */
  panel?: PanelOutput[];
}

export interface DeepPlanSession {
  id: string;
  projectPath: string;
  phase: DeepPlanPhase;
  /** The user's original task string, preserved verbatim. */
  task: string;
  /**
   * Deliverable kind, picked upfront. Controls the Chair's vision
   * template + drafter's output structure. Existing sessions backfill to
   * `'argumentative-essay'` (the legacy behaviour).
   */
  mode: DeepPlanMode;
  /** Hard constraints parsed from `task` on session creation. */
  requirements: PlanRequirements;
  /**
   * Dot-point intellectual spine of the piece: thesis, POV, section
   * intents, novel insights surfaced in conversation. Small (400–1500
   * words, usually closer to 400). Grown incrementally by the Chair as
   * the panel + user conversation evolves. Fed verbatim to the drafter
   * at handoff.
   */
  vision: string;
  messages: DeepPlanMessage[];
  /** Chair-authored questions awaiting user response, if any. */
  pendingQuestions: ChairQuestion[];
  /**
   * Free-chat notes the user has typed since the last panel round. These
   * don't trigger panel work on their own — they accumulate here and get
   * injected into the next panel round's context (via `sendToPanel` or
   * `advancePhase`) as "points the user raised in chat". Cleared when that
   * happens. Keeps the panel's expensive fanout out of casual conversation.
   */
  pendingChatNotes: string[];
  /**
   * Anchor ids the Chair has already been shown in prior rounds. Used to
   * dedupe what we send to the Chair each round — only NEW anchors get
   * rendered in the prompt. Keeps the Chair's context tight as the wiki
   * grows AND forces it to ground each vision update in evidence it
   * hasn't already had a chance to use.
   */
  seenAnchorIds: string[];
  /** Running count of panel rounds per phase (convergence heuristic). */
  roundsPerPhase: Record<DeepPlanPhase, number>;
  /** Running total of web-search queries dispatched by the panel. Capped at DEEP_PLAN_MAX_TOTAL_SEARCHES. */
  searchesUsed: number;
  tokensUsedK: number;
  createdAt: string;
  updatedAt: string;
  skipped: boolean;
  completed: boolean;
}

export interface DeepPlanStatus {
  active: boolean;
  shouldAutoStart: boolean;
  session: DeepPlanSession | null;
  /** True while a panel round (and any triggered research) is in flight. */
  roundRunning: boolean;
}

/**
 * Events broadcast from the research engine while it's looping so the
 * renderer can animate a live graph of the agent's exploration. Both Deep
 * Plan and Deep Search subscribe to the same event stream. Each event
 * carries a `runId` that ties it to a single invocation of the engine so
 * consumers can reset their state when a new run starts.
 */
export type DeepPlanResearchEvent =
  | { kind: 'run-start'; runId: string; source: 'deepPlan' | 'deepSearch' }
  | {
      kind: 'query-start';
      runId: string;
      queryId: string;
      query: string;
      rationale: string;
    }
  | {
      kind: 'result-seen';
      runId: string;
      queryId: string;
      resultId: string;
      url: string;
      title: string;
    }
  | {
      kind: 'result-ingested';
      runId: string;
      queryId: string;
      resultId: string;
      slug: string;
      name: string;
    }
  | {
      kind: 'result-skipped';
      runId: string;
      queryId: string;
      resultId: string;
      reason: 'duplicate' | 'too-short' | 'bot-block' | 'ingest-failed' | 'blocked-host';
    }
  | {
      kind: 'query-done';
      runId: string;
      queryId: string;
      ingestedCount: number;
    }
  | {
      kind: 'run-done';
      runId: string;
      totalIngested: number;
      totalQueries: number;
      reason: 'target-reached' | 'converged' | 'cancelled' | 'query-cap' | 'error';
    }
  | {
      kind: 'hint-added';
      runId: string;
      hint: string;
    };

export interface DeepSearchQueryRecord {
  queryId: string;
  query: string;
  rationale: string;
  ingestedCount: number;
  timestamp: string;
}

export interface DeepSearchStatus {
  running: boolean;
  runId: string | null;
  task: string | null;
  hints: string[];
  queries: DeepSearchQueryRecord[];
  totalIngested: number;
  lastError: string | null;
  /** ISO timestamp of the most recent state mutation, for UI ordering. */
  updatedAt: string;
}

/**
 * Snapshot of the signed-in user's account, quota, and currently-routed model.
 * Mirrors the `/api/v1/me` response shape (changes.md §4.3), trimmed to the
 * fields the desktop app actually uses.
 */
export interface MeQuotaBucket {
  period: 'day';
  /** null for Pro users — treat as unlimited. */
  limit: number | null;
  used: number;
  /** null when the bucket is unlimited. */
  remaining: number | null;
  resetsAt: string;
}

export interface MeCurrentModel {
  id: string;
  name: string;
  provider: string;
}

export interface MeSnapshot {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
  };
  plan: 'free' | 'pro' | string;
  quota: {
    chat: MeQuotaBucket;
    search: MeQuotaBucket;
  };
  rateLimit: {
    requestsPerMinute: number;
  };
  currentModel: MeCurrentModel | null;
  /** When this snapshot was fetched (ISO). Used to gate offline stale-reads. */
  fetchedAt: string;
}

export interface MeStatus {
  /** null on first launch or after sign-out. */
  snapshot: MeSnapshot | null;
  /** True while a refresh is in flight. */
  loading: boolean;
  /** Last error from `/api/v1/me`, if any. */
  error: string | null;
  /** True when the last fetch failed and we're displaying cached data. */
  offline: boolean;
}

/**
 * Auto-update state shared with the renderer. `disabled` means the app is
 * running unpackaged (dev) — the updater is a no-op and the UI should say so.
 * `downloaded` is the terminal happy-path state; clicking "Restart" triggers
 * `quitAndInstall`. Progress is percent complete (0–100) while downloading.
 */
export type UpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  error: string | null;
}
