export interface AppSettings {
  defaultModel: string;
  hasOpenRouterKey: boolean;
  hasTavilyKey: boolean;
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
}
