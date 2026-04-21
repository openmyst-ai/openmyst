export interface AppSettings {
  defaultModel: string;
  hasOpenRouterKey: boolean;
  hasJinaKey: boolean;
  deepPlanModel: string;
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

export const DEFAULT_DEEP_PLAN_MODEL = 'deepseek/deepseek-v3.2';
export const DEFAULT_SUMMARY_MODEL = 'google/gemini-2.5-flash-lite';

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

export const DEFAULT_MODEL = 'deepseek/deepseek-v3.2';

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
}

export type SourceAnchorType =
  | 'definition'
  | 'rule'
  | 'argument'
  | 'idea'
  | 'equation'
  | 'finding'
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

export type DeepPlanStage =
  | 'intent'
  | 'sources'
  | 'scoping'
  | 'gaps'
  | 'research'
  | 'synthesis'
  | 'handoff'
  | 'done';

export const DEEP_PLAN_STAGE_ORDER: DeepPlanStage[] = [
  'intent',
  'sources',
  'scoping',
  'gaps',
  'research',
  'synthesis',
  'handoff',
  'done',
];

export interface DeepPlanRubric {
  title: string | null;
  form: string | null;
  audience: string | null;
  lengthTarget: string | null;
  thesis: string | null;
  mustCover: string[];
  mustAvoid: string[];
  notes: string;
}

export interface DeepPlanMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  kind: 'chat' | 'stage-transition' | 'research-query' | 'research-note' | 'review-plan';
  timestamp: string;
}

export interface DeepPlanResearchQuery {
  query: string;
  rationale: string;
  resultsSeen: number;
  ingestedSlugs: string[];
  timestamp: string;
}

export interface DeepPlanSession {
  id: string;
  projectPath: string;
  stage: DeepPlanStage;
  task: string;
  rubric: DeepPlanRubric;
  messages: DeepPlanMessage[];
  researchQueries: DeepPlanResearchQuery[];
  researchHints: string[];
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
  researchRunning: boolean;
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
      reason: 'duplicate' | 'too-short' | 'bot-block' | 'ingest-failed';
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
