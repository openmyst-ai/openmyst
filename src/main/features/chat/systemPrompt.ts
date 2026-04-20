import type { DeepPlanRubric, PendingEdit } from '@shared/types';
import { WRITING_SKILL } from '../../writing';

/**
 * System prompt builder — the one file you touch to change how the agent is
 * briefed at the start of each turn. Split out from turn.ts deliberately:
 * tweaking the prompt is the single most common "I want to change agent
 * behavior" knob, and it should not live buried inside the orchestration
 * loop.
 *
 * The system content for a turn is the concatenation of:
 *   1. agent.md               — per-project persona/instructions
 *   2. tweak etiquette rider  — ask-for-feedback hint after edits
 *   3. active document label
 *   4. the full document text (delimited)
 *   5. pending-edits block    — the staging area the user hasn't accepted yet
 *   6. wiki index             — research memory surface (when non-empty)
 *
 * Pending edits and the wiki index are conditional; docs and agent.md are
 * always present.
 */

const TWEAK_ETIQUETTE =
  '\n\n[Revision etiquette] After proposing any myst_edit, end your chat with a short invitation like "Want me to tweak anything?" so the user can iterate naturally. To revise an existing pending edit, reuse the same old_string — never create a parallel pending entry.' +
  '\n\n[Edit sizing — critical] Keep every myst_edit old_string SHORT: one sentence ideally, never more than a few. To rewrite a paragraph, emit MULTIPLE small edits (one per sentence), not one giant block. Copy the snippet verbatim from the document — straight quotes vs curly quotes (\' vs \u2019, " vs \u201C/\u201D) and hyphen vs en-dash vs em-dash (- vs \u2013 vs \u2014) are different characters; match whichever one the document uses. Long old_strings fail to match far more often than short ones.' +
  '\n\n[Formatting parity — critical] Your new_string MUST match the document\'s existing formatting style exactly. Before writing, look at the surrounding text: Is it soft-wrapped at a fixed column, or one long line per paragraph? How many blank lines between paragraphs? Sentence-per-line or flowing? Which quote style (straight vs curly) and dash style (hyphen vs en-dash vs em-dash) does the doc use? Whatever the document does, do the same — never introduce a new line-wrap width, never switch quote/dash style mid-document. An edit that wraps differently from the surrounding prose lands as a visible seam and is a bug, not a feature.';

function buildPendingBlock(pending: PendingEdit[]): string {
  if (pending.length === 0) return '';
  return (
    '\n\n========== PENDING EDITS (awaiting user accept/reject — NOT in the document yet) ==========\n' +
    pending
      .map(
        (e, i) =>
          `--- Pending ${i + 1} ---\n` +
          `old_string: ${JSON.stringify(e.oldString)}\n` +
          `new_string:\n${e.newString}\n`,
      )
      .join('\n') +
    '==========\n' +
    'If the user is asking you to adjust a pending edit, you have two options:\n' +
    '  (a) Full rewrite — emit a myst_edit with the SAME old_string as the pending one; the system replaces that pending entry in place.\n' +
    '  (b) Surgical tweak — emit a myst_edit whose old_string is a SUBSTRING of the pending new_string above, and whose new_string is the fix. The system will patch that pending edit for you — you do NOT need the text to be in the document yet.\n' +
    'Either way, NEVER create a parallel pending entry when the user is refining the last one.'
  );
}

function rubricIsEmpty(r: DeepPlanRubric): boolean {
  return (
    !r.title &&
    !r.form &&
    !r.audience &&
    !r.lengthTarget &&
    !r.thesis &&
    r.mustCover.length === 0 &&
    r.mustAvoid.length === 0 &&
    !r.notes.trim()
  );
}

function buildRubricBlock(rubric: DeepPlanRubric | null): string {
  if (!rubric || rubricIsEmpty(rubric)) return '';
  const lines: string[] = [];
  if (rubric.title) lines.push(`Title: ${rubric.title}`);
  if (rubric.form) lines.push(`Form: ${rubric.form}`);
  if (rubric.audience) lines.push(`Audience: ${rubric.audience}`);
  if (rubric.lengthTarget) lines.push(`Length target: ${rubric.lengthTarget}`);
  if (rubric.thesis) lines.push(`Thesis: ${rubric.thesis}`);
  if (rubric.mustCover.length > 0) {
    lines.push('');
    lines.push('Must cover:');
    for (const m of rubric.mustCover) lines.push(`- ${m}`);
  }
  if (rubric.mustAvoid.length > 0) {
    lines.push('');
    lines.push('Must avoid:');
    for (const m of rubric.mustAvoid) lines.push(`- ${m}`);
  }
  const notes = rubric.notes.trim();
  if (notes) {
    lines.push('');
    lines.push('Notes:');
    lines.push(notes);
  }
  return (
    '\n\n========== BEGIN plan rubric (.myst/deep-plan/session.json) ==========\n' +
    lines.join('\n') +
    '\n========== END plan rubric ==========\n' +
    'This is the plan the user agreed to during Deep Plan. Treat it as the north star for the current writing task: honor the thesis, cover the must-cover items, and avoid the must-avoid ones. If the user asks about "the plan" or "the rubric", this is it. Don\'t contradict it without their consent — if something here no longer fits, flag it and ask.'
  );
}

function buildResearchQueriesBlock(queries: string[]): string {
  if (queries.length === 0) return '';
  const lines = queries.map((q) => `- "${q}"`).join('\n');
  return (
    '\n\n========== BEGIN research queries already run ==========\n' +
    lines +
    '\n========== END research queries already run ==========\n' +
    "These web searches have already been run during this project's Deep Plan / Deep Search sessions. Anything they surfaced is in the wiki index above. If the user asks for something adjacent, check the wiki first, then propose a NEW angle — don't re-run the same query expecting different results."
  );
}

function buildWebSearchBlock(): string {
  return (
    '\n\n[Web search — on-demand]\n' +
    'When the user asks about prior work, novelty, state-of-the-art, recent developments, or anything you need external evidence for, run one or more web searches by emitting a `web_search` fenced block. Each block takes a single `query` string. Results (title, URL, snippet) come back before your next turn so you can cite them with the URL.\n' +
    '```web_search\n{"query": "policy gradient nearest-neighbor reward shaping"}\n```\n' +
    'Rules:\n' +
    '- Emit multiple blocks in one response to search in parallel — they all resolve before your next turn.\n' +
    '- Use when the answer is NOT in the active document or wiki index above. Always check the wiki first.\n' +
    '- When citing a result, quote the URL verbatim. Never invent URLs or paraphrase a source you did not see.\n' +
    '- If the user explicitly asks you to "search" or "look up" or "find prior work", you MUST emit at least one web_search block before answering.\n' +
    '\n' +
    '[Grounding search queries — critical]\n' +
    'If the user references a local source by name (a slug, filename, or project-specific term like "nearest policy" or "the training script"), you MUST read the actual source BEFORE searching. Emit a `source_lookup` in the same response as your `web_search` — they resolve together in one round. Never guess what a source is about from its filename; filenames are ambiguous ("nearest_policy.py" could be nearest-neighbor imitation learning, k-NN retrieval-based control, or something else entirely). The query you send to the web must be built from concepts you actually read in the source — specific algorithm names, method names, paper titles it cites, the problem domain — not from the filename tokens. A query like "real world data policy enforcement" based only on the name "nearest policy" is a bug, not a search.'
  );
}

function buildWikiBlock(wikiIndex: string): string {
  if (!wikiIndex.trim()) return '';
  return (
    '\n\n========== BEGIN research wiki index (.myst/wiki/index.md — your default memory surface) ==========\n' +
    wikiIndex +
    '\n========== END research wiki index ==========\n' +
    'This index is loaded every turn. Treat it as the map of what you already know: one line per source, with a short summary and a slug. Do not ask the user to attach sources that are already here.\n\n' +
    '[Deep reference — on-demand lookup]\n' +
    'The index only shows summaries. When a source looks relevant, drill in with a `source_lookup` block. Three forms:\n\n' +
    '1) **Open a source page** — slug only. Returns the full detailed summary plus the list of available anchors (definitions, rules, arguments, equations, findings, sections). Use this whenever you want to know more about a source than the one-liner.\n' +
    '```source_lookup\n{"slug": "smith-2022"}\n```\n\n' +
    '2) **Pull a verbatim anchor** — slug + anchor id, after you\'ve seen the anchor menu from step 1. Returns the exact raw text for quoting, citation, or definition-checking.\n' +
    '```source_lookup\n{"slug": "smith-2022", "anchor": "law-1-2"}\n```\n\n' +
    '3) **Read a raw file** — slug + `"raw": true`. Returns the full verbatim contents of a raw-typed source (code, CSV, JSON, etc. the user dropped in). Raw sources have no anchors and no LLM summary — you only see them if you ask. Capped at 50 KB; larger files come back truncated with a marker. Use this when the user\'s task references a specific script or data file by name.\n' +
    '```source_lookup\n{"slug": "train_py", "raw": true}\n```\n\n' +
    'You may emit multiple lookups in one response; each resolves independently and the results are injected back before your next turn. Lookups are cheap — use them liberally, and NEVER paraphrase quotes from memory.'
  );
}

export interface SystemPromptInput {
  agentPrompt: string;
  activeDocument: string;
  docLabel: string;
  document: string;
  pending: PendingEdit[];
  wikiIndex: string;
  rubric: DeepPlanRubric | null;
  researchQueries: string[];
}

const WRITING_STYLE_RIDER =
  '\n\n========== BEGIN writing-style guide — applies to any prose you write for the user (myst_edit new_strings, rewrites, draft continuations). Does NOT apply to short conversational replies like "done", "sure", or answering a question about the doc. When you are about to produce prose the user will read as part of their document, internalise this first. ==========\n' +
  WRITING_SKILL +
  '\n========== END writing-style guide ==========';

export function buildSystemPrompt(input: SystemPromptInput): string {
  const {
    agentPrompt,
    activeDocument,
    docLabel,
    document,
    pending,
    wikiIndex,
    rubric,
    researchQueries,
  } = input;
  return [
    agentPrompt,
    TWEAK_ETIQUETTE,
    buildRubricBlock(rubric),
    `\n\n[Active document: ${docLabel}]`,
    `\n\n========== BEGIN ${activeDocument} ==========\n` +
      document +
      `\n========== END ${activeDocument} ==========`,
    buildPendingBlock(pending),
    buildWebSearchBlock(),
    buildWikiBlock(wikiIndex),
    buildResearchQueriesBlock(researchQueries),
    WRITING_STYLE_RIDER,
  ].join('');
}
