import type { PendingEdit } from '@shared/types';
import type { PlanLookupPayload } from './contextLookups';
import { PROSE_STYLE } from '../../writing';

/**
 * System prompt builder — the minimal-static version.
 *
 * What the model sees EVERY turn (always inlined):
 *   1. agent.md                 — per-project persona/instructions
 *   2. tweak + format etiquette — ask-for-feedback + match doc formatting
 *   3. pending edits block      — the staging area the user hasn't accepted
 *   4. active-doc label + char count (NOT the body)
 *   5. optional "Deep Plan completed: …" one-liner (when a plan exists)
 *   6. wiki index               — short source list, needed so the model
 *                                 knows what it CAN pull via source_lookup
 *   7. lookup/tool protocols    — doc_lookup, plan_lookup, queries_lookup,
 *                                 source_lookup (via wiki block), web_search
 *   8. prose-style guide        — hard rules + distilled humanizer
 *
 * What the model pulls ON DEMAND (new in this revision):
 *   - the document body itself (`doc_lookup` — full, find-window, or range)
 *   - the Deep Plan plan.md + requirements (`plan_lookup`)
 *   - prior research queries (`queries_lookup`)
 *
 * Rationale: short turns ("change the title") no longer drag the full doc +
 * plan + queries through context. Meaningful turns pull what they need in
 * one extra round. The lookup loop in turn.ts (MAX_LOOKUP_ROUNDS) resolves
 * these in parallel with source/web lookups, so most turns still complete in
 * a single follow-up.
 */

const TWEAK_ETIQUETTE =
  '\n\n[Revision etiquette] After proposing any myst_edit, end your chat with a short invitation like "Want me to tweak anything?" so the user can iterate naturally. To revise an existing pending edit, reuse the same old_string — never create a parallel pending entry.' +
  '\n\n[Edit sizing — critical] Keep every myst_edit old_string SHORT: one sentence ideally, never more than a few. To rewrite a paragraph, emit MULTIPLE small edits (one per sentence), not one giant block. Copy the snippet verbatim from the document — straight quotes vs curly quotes (\' vs \u2019, " vs \u201C/\u201D) and hyphen vs en-dash vs em-dash (- vs \u2013 vs \u2014) are different characters; match whichever one the document uses. Long old_strings fail to match far more often than short ones.' +
  '\n\n[Formatting parity — critical] Your new_string MUST match the document\'s existing formatting style exactly. Before writing, look at the surrounding text (pull it via `doc_lookup` with a `find` needle): Is it soft-wrapped at a fixed column, or one long line per paragraph? How many blank lines between paragraphs? Sentence-per-line or flowing? Which quote style (straight vs curly) and dash style (hyphen vs en-dash vs em-dash) does the doc use? Whatever the document does, do the same — never introduce a new line-wrap width, never switch quote/dash style mid-document. An edit that wraps differently from the surrounding prose lands as a visible seam and is a bug, not a feature.';

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

function planIsEmpty(p: PlanLookupPayload): boolean {
  const r = p.requirements;
  return (
    p.vision.trim().length === 0 &&
    p.anchorLogSize === 0 &&
    r.wordCountMin === null &&
    r.wordCountMax === null &&
    !r.form &&
    !r.audience &&
    !r.styleNotes
  );
}

/**
 * One-line teaser so the model knows a plan exists and can decide whether
 * to pull it. We never inline the plan itself — `plan_lookup` gets it.
 */
function buildPlanTeaser(plan: PlanLookupPayload | null): string {
  if (!plan || planIsEmpty(plan)) return '';
  const r = plan.requirements;
  const bits: string[] = [];
  if (r.form) bits.push(r.form);
  if (r.wordCountMin !== null && r.wordCountMax !== null) {
    bits.push(
      r.wordCountMin === r.wordCountMax
        ? `~${r.wordCountMin} words`
        : `${r.wordCountMin}–${r.wordCountMax} words`,
    );
  }
  if (r.audience) bits.push(`for ${r.audience}`);
  const label = bits.join(', ') || 'writing plan';
  return (
    `\n\n[Deep Plan in play] ${label}. The full plan.md (thesis, section beats, source attributions) and hard requirements live behind \`plan_lookup\`. Pull it when the user references "the plan", or when you're about to make a structural decision.`
  );
}

function buildDocHeader(docLabel: string, docChars: number): string {
  return (
    `\n\n[Active document: ${docLabel} — ${docChars} chars]\n` +
    'The document body is NOT inlined. Pull it on demand with `doc_lookup` (see tool protocols below). For small asks ("change the title"), pull only the paragraph around the target via `{"find": "..."}`. For rewrites or audits, pull the full body with `{}`.'
  );
}

function buildLookupProtocols(): string {
  return (
    '\n\n[doc_lookup — on-demand document read]\n' +
    'Emit a `doc_lookup` fence to pull the active document. Three forms:\n\n' +
    '1) **Full body** — when you need the whole thing (rewrites, audits, summary of current state).\n' +
    '```doc_lookup\n{}\n```\n\n' +
    '2) **Paragraph window around a phrase** — cheapest option. Returns one paragraph before and after the first match, case-insensitive. Use this whenever you know a snippet of text near the edit site.\n' +
    '```doc_lookup\n{"find": "pareto optimality"}\n```\n\n' +
    '3) **Character range** — when you need a specific region (e.g. the opening 500 chars).\n' +
    '```doc_lookup\n{"from": 0, "to": 500}\n```\n\n' +
    'Multiple `doc_lookup` blocks in one response resolve in parallel. Prefer `find` over full-body whenever possible — full-body reads are the biggest token cost of a turn.\n\n' +
    '[plan_lookup — pull the Deep Plan plan.md and requirements]\n' +
    '```plan_lookup\n{}\n```\n' +
    'Returns the task, hard requirements (word count, form, audience, style notes), and the full plan.md that the panel built. Call when the user references "the plan", or before a structural decision.\n\n' +
    '[queries_lookup — see what research has already been run]\n' +
    '```queries_lookup\n{}\n```\n' +
    "Returns every web search this project has already run during Deep Plan / Deep Search. Call before running a new web_search if the user's ask overlaps prior research territory — don't re-run the same query expecting different results."
  );
}

function buildWebSearchBlock(): string {
  return (
    '\n\n[Web search — on-demand]\n' +
    'When the user asks about prior work, novelty, state-of-the-art, recent developments, or anything you need external evidence for, emit a `web_search` fence. Each block takes one `query` string. Results (title, URL, snippet) come back before your next turn so you can cite with the URL.\n' +
    '```web_search\n{"query": "policy gradient nearest-neighbor reward shaping"}\n```\n' +
    'Rules:\n' +
    '- Emit multiple blocks in one response to search in parallel.\n' +
    '- Use when the answer is NOT in the active document or wiki index. Check the wiki first (`source_lookup`) and prior queries (`queries_lookup`) before searching.\n' +
    '- When citing a result, quote the URL verbatim. Never invent URLs.\n' +
    '- If the user explicitly asks you to "search" / "look up" / "find prior work", you MUST emit at least one web_search block before answering.\n\n' +
    '[Grounding search queries — critical]\n' +
    'If the user references a local source by name (a slug, filename, or project-specific term), you MUST read the actual source BEFORE searching. Emit a `source_lookup` in the same response as your `web_search` — they resolve together in one round. Never guess what a source is about from its filename; the query must be built from concepts you actually read.'
  );
}

function buildWikiBlock(wikiIndex: string): string {
  if (!wikiIndex.trim()) return '';
  return (
    '\n\n========== BEGIN research wiki index (.myst/wiki/index.md — your default memory surface) ==========\n' +
    wikiIndex +
    '\n========== END research wiki index ==========\n' +
    'This index is the map of what the project already knows: one line per source, with a short summary and a slug. Do not ask the user to attach sources that are already here.\n\n' +
    '[source_lookup — on-demand deep reference]\n' +
    'The index only shows summaries. When a source looks relevant, drill in with a `source_lookup` block. Three forms:\n\n' +
    '1) **Open a source page** — slug only. Returns the full detailed summary plus the list of available anchors.\n' +
    '```source_lookup\n{"slug": "smith-2022"}\n```\n\n' +
    '2) **Pull a verbatim anchor** — slug + anchor id, after you\'ve seen the anchor menu.\n' +
    '```source_lookup\n{"slug": "smith-2022", "anchor": "law-1-2"}\n```\n\n' +
    '3) **Read a raw file** — slug + `"raw": true`. Returns the full verbatim contents of a raw-typed source. Capped at 50 KB.\n' +
    '```source_lookup\n{"slug": "train_py", "raw": true}\n```\n\n' +
    'Multiple lookups in one response resolve in parallel. Lookups are cheap — use them liberally, and NEVER paraphrase quotes from memory.'
  );
}

export interface SystemPromptInput {
  agentPrompt: string;
  activeDocument: string;
  docLabel: string;
  document: string;
  pending: PendingEdit[];
  wikiIndex: string;
  plan: PlanLookupPayload | null;
  researchQueries: string[];
}

const WRITING_STYLE_RIDER =
  '\n\n========== BEGIN prose-style guide. Applies to any prose the user will read (myst_edit new_strings, rewrites, chat answers, short replies). STRICTLY SECONDARY to the fenced-protocol rules above (doc_lookup, plan_lookup, queries_lookup, source_lookup, myst_edit, web_search). If the two conflict, fence rules win. ==========\n' +
  PROSE_STYLE +
  '\n========== END prose-style guide ==========';

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { agentPrompt, docLabel, document, pending, wikiIndex, plan } = input;
  return [
    agentPrompt,
    TWEAK_ETIQUETTE,
    buildPlanTeaser(plan),
    buildDocHeader(docLabel, document.length),
    buildPendingBlock(pending),
    buildLookupProtocols(),
    buildWebSearchBlock(),
    buildWikiBlock(wikiIndex),
    WRITING_STYLE_RIDER,
  ].join('');
}
