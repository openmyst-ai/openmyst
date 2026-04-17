export interface AppSettings {
  defaultModel: string;
  hasOpenRouterKey: boolean;
  hasJinaKey: boolean;
  deepPlanModel: string;
  recentProjects: string[];
}

export const DEFAULT_DEEP_PLAN_MODEL = 'deepseek/deepseek-chat';

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

export const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';

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

export interface SourceMeta {
  slug: string;
  name: string;
  originalName: string;
  type: 'pdf' | 'markdown' | 'text' | 'pasted';
  addedAt: string;
  summary: string;
  indexSummary: string;
  sourcePath?: string;
  anchors?: SourceAnchorSummary[];
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
  | 'clarify'
  | 'review'
  | 'handoff'
  | 'done';

export const DEEP_PLAN_STAGE_ORDER: DeepPlanStage[] = [
  'intent',
  'sources',
  'scoping',
  'gaps',
  'research',
  'clarify',
  'review',
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
