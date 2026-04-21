import type {
  ChairAnswerMap,
  ChairQuestion,
  DeepPlanPhase,
  DeepPlanSession,
  PanelOutput,
  PanelRole,
  PlanRequirements,
  SourceMeta,
} from '@shared/types';
import {
  DEEP_PLAN_MAX_QUESTIONS_PER_ROUND,
  DEEP_PLAN_MAX_SEARCHES_PER_ROUND,
  DEEP_PLAN_MAX_TOTAL_SEARCHES,
  DEEP_PLAN_SOFT_ROUND_LIMIT_PER_PHASE,
} from '@shared/types';
import { PROSE_STYLE } from '../../writing';

/**
 * Prompt templates for the plan.md-centric Deep Plan pipeline.
 *
 * The pipeline pivots on one artefact: `plan.md`, a living document the panel
 * refines each round and the Chair rewrites in full. Everything else
 * (requirements, wiki sources, Prose-Style commands) is reference material
 * the panel and Chair read to judge the plan. At handoff, the drafter sees
 * only the four things that matter: requirements, commands, plan.md, sources.
 *
 *   - `panelistPrompt` — cheap-model adversarial panelist. Reads plan +
 *     requirements + wiki, proposes specific plan edits, emits needsResearch
 *     only as a last resort.
 *   - `chairPrompt` — strong-model Chair. Rewrites plan.md in full, emits
 *     ≤ 3 questions only when a judgment call genuinely needs the user.
 *   - `preDraftLookupPrompt` / `oneShotPrompt` — handoff to the drafter.
 *   - `deepSearchPlannerPrompt` — kept for the independent Deep Search
 *     feature; takes `PlanRequirements` now instead of a rubric.
 */

/** Commands bundle — house rules for prose (em-dash ban, slug format, etc.). */
export const DEEP_PLAN_COMMANDS: string = PROSE_STYLE;

/* ───────────────────────────── Shared blocks ───────────────────────────── */

/**
 * Names the hard-requirement fields the task string didn't pin down. The
 * Chair uses this to decide whether to open the round by asking the user
 * for the missing constraints (word count, form, audience) before burning
 * more panel rounds on a plan that can't be judged against anything.
 */
function missingRequirements(req: PlanRequirements): string[] {
  const missing: string[] = [];
  if (req.wordCountMin === null && req.wordCountMax === null) missing.push('word count');
  if (!req.form) missing.push('form');
  if (!req.audience) missing.push('audience');
  return missing;
}

function requirementsBlock(req: PlanRequirements): string {
  const lengthLine = (() => {
    if (req.wordCountMin !== null && req.wordCountMax !== null) {
      if (req.wordCountMin === req.wordCountMax) {
        return `- Word count: ~${req.wordCountMin} words (hard target — do not exceed by more than 10%)`;
      }
      return `- Word count: ${req.wordCountMin}–${req.wordCountMax} words (HARD RANGE — the draft MUST land inside this window)`;
    }
    if (req.wordCountMin !== null) return `- Word count: at least ${req.wordCountMin} words`;
    if (req.wordCountMax !== null) return `- Word count: at most ${req.wordCountMax} words`;
    return `- Word count: (not specified)`;
  })();
  return [
    lengthLine,
    `- Form: ${req.form ?? '(not specified)'}`,
    `- Audience: ${req.audience ?? '(not specified)'}`,
    `- Style notes: ${req.styleNotes ?? '(none)'}`,
  ].join('\n');
}

function planBlock(plan: string): string {
  const trimmed = plan.trim();
  if (!trimmed) {
    return '_(plan.md is empty — this is the first round. Propose its initial skeleton.)_';
  }
  return trimmed;
}

function sourcesBlock(sources: SourceMeta[]): string {
  if (sources.length === 0) return '_No sources yet._';
  return sources
    .map((s) => {
      const head = `- **${s.name}** (${s.slug}): ${s.indexSummary}`;
      if (!s.anchors || s.anchors.length === 0) return head;
      const anchorLines = s.anchors
        .map((a) => `    - \`${s.slug}#${a.id}\` [${a.type}] ${a.label}`)
        .join('\n');
      return `${head}\n${anchorLines}`;
    })
    .join('\n');
}

function richSourcesBlock(
  sources: SourceMeta[],
  detailedSummaries: Map<string, string>,
): string {
  if (sources.length === 0) return '_No sources yet._';
  return sources
    .map((s) => {
      const detail = detailedSummaries.get(s.slug)?.trim() || s.indexSummary;
      const anchorsBlock =
        s.anchors && s.anchors.length > 0
          ? `\n\nKey anchors in this source (specific claims/arguments/findings to weave in where they're relevant):\n` +
            s.anchors.map((a) => `- [${a.type}] ${a.label}`).join('\n')
          : '';
      return `### ${s.name} (\`${s.slug}\`)\n\n${detail}${anchorsBlock}`;
    })
    .join('\n\n---\n\n');
}

function searchBudgetBlock(session: DeepPlanSession): string {
  const remaining = Math.max(0, DEEP_PLAN_MAX_TOTAL_SEARCHES - session.searchesUsed);
  return `Search budget: ${session.searchesUsed}/${DEEP_PLAN_MAX_TOTAL_SEARCHES} used, ${remaining} remaining. Per-round panel cap: ${DEEP_PLAN_MAX_SEARCHES_PER_ROUND}. Searches are welcome — especially early, when the plan is sparse and one grounding source can sharpen a whole section. Don't burn every round on searches, but don't go silent either: when a specific plan claim would land harder with a primary source the wiki doesn't have yet, propose the query.`;
}

export const DEEP_REFERENCE_RIDER = `[Deep reference] Each source above may list anchor ids (format \`slug#anchor-id\`) beneath it. To pull the EXACT verbatim passage for an anchor, emit a fenced \`source_lookup\` block. The system will resolve it deterministically and inject the verbatim text into the conversation before your next turn. Never paraphrase quotes from memory — use the lookup.

Format:
\`\`\`source_lookup
{"slug": "smith-2022", "anchor": "law-1-2"}
\`\`\`
Multiple lookups in one response are fine. Use them freely when precision matters.`;

/* ────────────────────────── Panel (cheap-model) ────────────────────────── */

const ROLE_PERSONAS: Record<PanelRole, string> = {
  explorer: `EXPLORER. Expand the problem space. Look for adjacent angles, analogies, framings, or sub-topics the plan has not considered. When the plan is vague, propose concrete directions it could take. You open doors; you do not close them.`,

  scoper: `SCOPER. Push the plan toward concreteness. Flag anything vague — a fuzzy thesis, an unnamed audience, an abstract claim that needs a specific example, a scope too broad for the length. Each finding names one specific abstraction and demands a specific answer.`,

  stakes: `STAKES-RAISER. Force "so what?" and "for whom?". If the stakes are unclear, the piece has no reason to exist. A finding from you always names a stake that's missing or under-articulated.`,

  architect: `ARGUMENT ARCHITECT. Propose or stress-test the thesis chain — the sub-claims that must hold for the main claim to hold. Flag where the chain breaks, where a sub-claim is load-bearing but unsupported, where a better framing exists. Your suggestedAction names the specific chain surgery required.`,

  evidence: `EVIDENCE SCOUT. Identify claims the plan makes (or will make) that need external evidence. Your findings are pointers to gaps in the wiki. You are the ONE role where \`needsResearch\` is acceptable — but only when (a) the gap genuinely blocks a specific plan claim and (b) no source in the wiki already covers it. Prefer primary sources (papers, official docs, firsthand accounts).`,

  steelman: `STEELMAN. Construct the strongest opposing position to the plan's emerging thesis. State it in one or two sentences, charitably and accurately. Then check whether the plan has a response. If not, that is a high-severity finding — the plan will fall to this objection unless it addresses it.`,

  skeptic: `SKEPTIC. Find claims that would collapse under pressure — unstated assumptions, weak evidence, logical gaps, overreach. Be harsh. Every finding names a specific claim and the specific failure mode. Do not raise stylistic issues — that is the Editor's job.`,

  adversary: `ADVERSARY. Read the plan as a hostile reviewer would. Where is the argument most vulnerable? What will a reader attack first? What question will stop them dead on first read? Findings here are framed as "a hostile reader will say: …".`,

  editor: `EDITOR. Look for redundancy, broken through-lines, pacing problems, and coherence gaps in the plan's section structure. Findings name specific sections or beats and why they don't carry their weight. Suggest cuts and reorderings.`,

  audience: `AUDIENCE. Inhabit the stated reader. What will land? What will confuse? What do they already know (so don't belabour it)? What do they not know (so explain it)? Findings name specific passages or claims and predict the reader's reaction.`,

  finaliser: `FINALISER. Propose the concrete section-by-section beat sheet the drafter will use. Each beat is ONE finding with severity "low" and a suggestedAction of the form:
"BEAT: <short title> — <one-line intent>. Anchors: <slug1>[#anchor-id], <slug2>.".
Emit beats in reading order. Include 4–8 beats. The Chair will fold these into the plan.md outline.`,
};

interface PanelContext {
  session: DeepPlanSession;
  sources: SourceMeta[];
  lastChairSummary: string | null;
  lastAnswers: ChairAnswerMap | null;
  priorFindingsDigest: string;
  remainingSearchBudget: number;
}

function answersBlock(answers: ChairAnswerMap | null, questions: ChairQuestion[]): string {
  if (!answers || Object.keys(answers).length === 0) return '(no answers yet)';
  const byId = new Map(questions.map((q) => [q.id, q]));
  const lines: string[] = [];
  for (const [id, ans] of Object.entries(answers)) {
    const q = byId.get(id);
    const prompt = q?.prompt ?? `(question ${id})`;
    if (ans === null) {
      lines.push(`- Q: ${prompt}\n  A: (delegated to panel)`);
      continue;
    }
    if (Array.isArray(ans)) {
      const labels = ans.map((choiceId) => {
        const c = q?.choices?.find((x) => x.id === choiceId);
        return c ? c.label : choiceId;
      });
      lines.push(`- Q: ${prompt}\n  A: ${labels.join(', ')}`);
      continue;
    }
    if (q?.type === 'choice' || q?.type === 'confirm') {
      const c = q.choices?.find((x) => x.id === ans);
      lines.push(`- Q: ${prompt}\n  A: ${c ? c.label : ans}`);
    } else {
      lines.push(`- Q: ${prompt}\n  A: ${ans}`);
    }
  }
  return lines.join('\n');
}

function panelContextBlock(ctx: PanelContext): string {
  const { session, sources, lastChairSummary, lastAnswers, priorFindingsDigest } = ctx;
  const lastQuestions = (() => {
    const lastChairMsg = [...session.messages].reverse().find((m) => m.kind === 'chair-turn');
    return lastChairMsg?.chair?.questions ?? [];
  })();
  return [
    `User's task: "${session.task}"`,
    `Current phase: ${session.phase}`,
    '',
    'Task requirements (hard constraints — the final draft MUST honour these):',
    requirementsBlock(session.requirements),
    '',
    'Current plan.md (the living artefact — this is what you are here to improve):',
    planBlock(session.plan),
    '',
    'Wiki — sources already ingested:',
    sourcesBlock(sources),
    '',
    searchBudgetBlock(session),
    '',
    lastChairSummary
      ? `Last Chair summary to the user:\n"${lastChairSummary}"`
      : '(this is the first panel round for this phase)',
    '',
    `Last user answers:\n${answersBlock(lastAnswers, lastQuestions)}`,
    '',
    priorFindingsDigest
      ? `Prior-round findings digest (do NOT repeat these — raise NEW points):\n${priorFindingsDigest}`
      : '(no prior rounds)',
  ].join('\n');
}

export function panelistPrompt(role: PanelRole, ctx: PanelContext): string {
  const persona = ROLE_PERSONAS[role];
  const canSearch = ctx.remainingSearchBudget > 0;
  const searchClause = canSearch
    ? `- \`needsResearch\`: up to ${DEEP_PLAN_MAX_SEARCHES_PER_ROUND} queries when a specific plan claim would land harder with a source the wiki lacks. Any role may request — not just Evidence. Early ideation rounds benefit most: one or two seed queries on the core concept can reshape the whole plan.`
    : `- \`needsResearch\`: emit []. The session search budget is exhausted — work with the plan and wiki you already have.`;

  return `You are ONE voice on an adversarial panel that is iteratively refining a writer's plan.md. You do NOT talk to the writer. You report structured findings to the Chair, who rewrites plan.md in full and synthesises the round for the user.

Your role:
${persona}

Context:
${panelContextBlock(ctx)}

Your job this round:
1. Read the current plan.md carefully. It is not empty in most rounds — it is the result of prior panel feedback.
2. Through your role's lens, identify the 2–3 things that most need to change in the plan. Be specific: name the section, the claim, the framing, or the beat.
3. For each finding, your \`suggestedAction\` should read as a concrete plan edit the Chair could apply verbatim ("rewrite §2 to open with the counter-example from smith-2022", "drop the intro paragraph — it restates the thesis before earning it", "add a §3.5 that names the opposing view and responds to it").
4. Searching is allowed and encouraged when the wiki lacks a source a specific plan claim would lean on. The goal is reasoning *plus* grounding: reasoning alone produces a plan that sounds confident but isn't anchored. In early ideation rounds especially, propose one or two seed queries on the core concept when the wiki is bare.

Output ONLY a JSON object of this exact shape — no prose, no markdown fences, no commentary:

{
  "findings": [
    {
      "severity": "high" | "mid" | "low",
      "claim": "one sentence naming what you observed in the plan",
      "rationale": "one sentence saying why it matters",
      "suggestedAction": "one sentence naming the concrete plan edit the Chair should make"
    }
  ],
  "needsResearch": [
    {"query": "3–5 plain lowercase terms, no site: filters", "rationale": "which specific plan claim this query unblocks"}
  ]
}

Rules:
- At most 3 findings. Quality over quantity. Vague findings are worthless.
${searchClause}
- Do NOT duplicate findings already raised in prior rounds (see digest above).
- If you genuinely have nothing to add this round, output {"findings": [], "needsResearch": []}. This is the right answer more often than you think — the plan converges when the panel goes quiet.`;
}

/* ────────────────────────── Chair (strong-model) ────────────────────────── */

const PHASE_INTENT: Record<DeepPlanPhase, string> = {
  ideation: `IDEATION — shape a vague task into a concrete idea. By end of phase the plan has a clear thesis candidate, an identified audience, and a rough angle. Plan.md at this phase is a skeleton: thesis sentence, audience line, a rough section list. Light on evidence.`,
  planning: `PLANNING — identify the key points, arguments, and evidence the piece will use. Plan.md gains sub-sections, per-section thesis beats, and source attributions. The strongest counter-argument appears in the plan with a response.`,
  reviewing: `REVIEWING — stress-test the plan and lock the concrete section beat sheet. Plan.md at end of phase reads as something a drafter could write from directly: every section has a title, a one-line intent, and the anchors it leans on.`,
  done: `DONE — the drafter has written the piece. You should not be called in this phase.`,
};

function findingsBlock(panelOutputs: PanelOutput[]): string {
  if (panelOutputs.length === 0) return '(panel was silent this round)';
  return panelOutputs
    .map((p) => {
      const header = `### ${p.role.toUpperCase()}`;
      if (p.findings.length === 0 && p.needsResearch.length === 0) {
        return `${header}\n(no findings this round)`;
      }
      const findings = p.findings
        .map(
          (f) =>
            `- [${f.severity.toUpperCase()}] ${f.claim}\n  why: ${f.rationale}\n  action: ${f.suggestedAction}`,
        )
        .join('\n');
      const research =
        p.needsResearch.length > 0
          ? `\nResearch requested:\n${p.needsResearch
              .map((r) => `  - "${r.query}" — ${r.rationale}`)
              .join('\n')}`
          : '';
      return `${header}\n${findings}${research}`;
    })
    .join('\n\n');
}

function priorChairDigest(session: DeepPlanSession, limit = 3): string {
  const chairTurns = session.messages
    .filter((m) => m.kind === 'chair-turn' && m.chair)
    .slice(-limit);
  if (chairTurns.length === 0) return '';
  return chairTurns
    .map((m, i) => `Round ${session.messages.length - chairTurns.length + i + 1}: "${m.chair!.summary}"`)
    .join('\n');
}

export interface ChairPromptArgs {
  session: DeepPlanSession;
  panelOutputs: PanelOutput[];
  newlyIngestedSourceSlugs: string[];
  roundNumber: number;
  sources: SourceMeta[];
}

export function chairPrompt(args: ChairPromptArgs): string {
  const { session, panelOutputs, newlyIngestedSourceSlugs, roundNumber, sources } = args;
  const phase = session.phase;
  const priorSummaries = priorChairDigest(session);
  const missing = missingRequirements(session.requirements);
  const requirementsComplete = missing.length === 0;
  const softLimitHit = roundNumber >= DEEP_PLAN_SOFT_ROUND_LIMIT_PER_PHASE;
  const researchNote =
    newlyIngestedSourceSlugs.length > 0
      ? `\nResearch dispatched this round landed ${newlyIngestedSourceSlugs.length} new source(s) in the wiki: ${newlyIngestedSourceSlugs.join(', ')}. Factor these into your rewrite.`
      : '';
  const requirementsGap = !requirementsComplete
    ? `\n\n[Requirements gap] The task string didn't pin down: ${missing.join(', ')}. Ask about these NOW — they're the hardest constraints on the final draft and the panel can't judge the plan without them. Use \`choice\` questions with sensible defaults marked \`recommended\`. Do NOT set \`phaseAdvance: true\` while any of these are still open.`
    : '';
  const advanceNudge = softLimitHit && requirementsComplete
    ? `\n\n[Round pressure] This is round ${roundNumber} of this phase. The user has given you enough signal — strongly prefer \`phaseAdvance: true\` and, if you ask a question, make it a single confirm-style "ready to move on?" rather than opening a new line of inquiry.`
    : softLimitHit
      ? `\n\n[Round pressure] This is round ${roundNumber} — normally we'd be ready to advance, but requirements are still incomplete (see above). Finish those first, then advance next round.`
      : '';

  return `You are the CHAIR of an adversarial panel helping a writer build a plan.md. The panel has just produced ${panelOutputs.length} sets of findings. Your job has two parts:

  1. REWRITE plan.md in full — absorb the panel's edits, keep what works, improve what doesn't. This is the artefact the final drafter will read.
  2. Speak to the user in a short summary, and ONLY when a genuine judgment call needs them, ask 1–${DEEP_PLAN_MAX_QUESTIONS_PER_ROUND} targeted questions.

Phase intent:
${PHASE_INTENT[phase]}

Current round in this phase: ${roundNumber}${advanceNudge}
User's task: "${session.task}"

Task requirements (hard constraints — the plan MUST honour these; echo the word-count range inside the plan body where relevant):
${requirementsBlock(session.requirements)}${requirementsGap}

${searchBudgetBlock(session)}

Wiki — sources ingested so far (use these slugs verbatim when the plan attributes a claim):
${sourcesBlock(sources)}

Current plan.md (what you are rewriting — do NOT start from scratch unless this is empty):
${planBlock(session.plan)}

Panel findings this round:
${findingsBlock(panelOutputs)}${researchNote}

${priorSummaries ? `Prior-round Chair summaries (do NOT repeat these — move the plan FORWARD):\n${priorSummaries}\n\n` : ''}Output ONLY a JSON object of this exact shape — no prose, no markdown fences:

{
  "summary": "≤ 2 sentences, ≤ 60 words. What changed in plan.md this round and (if you're asking) what you need from the user.",
  "plan": "the FULL rewritten plan.md as a markdown string. Use \\n for line breaks inside the JSON string.",
  "questions": [
    {
      "id": "q1",
      "type": "choice" | "multi" | "open" | "confirm",
      "prompt": "the question as a single clear sentence",
      "choices": [
        {"id": "short-id", "label": "the option as the user sees it", "recommended": true}
      ],
      "allowCustom": false,
      "rationale": "optional one-line why this matters"
    }
  ],
  "phaseAdvance": true | false,
  "requirementsPatch": {
    "wordCountMin": 1500, "wordCountMax": 2500,
    "form": "exploratory essay",
    "audience": "general educated reader",
    "styleNotes": null
  } | null
}

plan.md rules:
- Rewrite it IN FULL every round. The drafter only ever sees the latest version.
- Structure: start with a title (H1), then a short thesis paragraph, then sections (H2) in reading order. Each section has a one-line intent and (from planning phase onward) source attributions in the form \`([Name](slug.md))\`.
- Honour the task requirements at the top of the plan — echo the word-count range and form in the thesis paragraph so the drafter can't miss them.
- Cite source slugs that actually exist in the wiki above. Never invent a slug.
- Plan.md is the drafter's sole planning input. If it's not in the plan, it won't make it into the draft.

Question rules:
- **FIRST PRIORITY — missing hard requirements.** If the requirements block above lists any field as "(not specified)" (especially word count), ask about them THIS ROUND. Word count is the tightest constraint on a draft and the panel literally cannot judge scope/depth without it. Use \`choice\` with 3–4 reasonable defaults and mark the panel's preferred option \`recommended\`. Example for word count: {1000–1500, 1500–2500, 2500–4000, custom write-in with \`allowCustom: true\`}.
- At most ${DEEP_PLAN_MAX_QUESTIONS_PER_ROUND} questions. Once requirements are complete, the user has delegated reasoning to the panel — ASK ONLY when a judgment call genuinely needs them (a thesis fork, a scope trade-off, a framing they haven't signalled). If the panel surfaced no such call AND requirements are already locked, emit [].
- Prefer \`choice\` (labelled options) > \`confirm\` (yes/no) > \`multi\` > \`open\`. Open questions are heavy — use one only when no set of options captures the space.
- On \`choice\` questions, mark ONE option with \`"recommended": true\` when there's a defensible default the panel leans toward. That option is what the panel would pick if the user delegated.
- On \`choice\` questions, set \`"allowCustom": true\` when your options don't exhaust the space — the UI will offer a "Write my own" write-in.
- Every \`choice\`/\`multi\` question MUST include 2–5 \`choices\`. \`confirm\` questions do not need \`choices\` (the UI injects Yes/No).
- Questions go into a dedicated card, not into chat. Phrase them so they read standalone.

phaseAdvance rule:
- NEVER \`true\` while any hard requirement (word count, form, audience) is still "(not specified)". The plan can't mature without these.
- \`true\` when (a) all hard requirements are filled, (b) the panel surfaced no substantive new tensions this round, and (c) plan.md has what it needs for this phase. Err toward \`false\` until round ${DEEP_PLAN_SOFT_ROUND_LIMIT_PER_PHASE} — then err toward \`true\` (but still gated on (a)).

Summary voice: calm, opinionated, colleague-like. Not a lecture. Not a sales pitch. Terse.`;
}

/* ─────────────────── Deep Search planner ─────────────────── */

const QUERY_STYLE = `Write queries like a research librarian, not a power user:
- 3–5 plain keywords, lowercase, no punctuation.
- Avoid quoted phrases unless the exact wording is a term of art (e.g. "chain of thought"). Multiple quoted phrases AND'd together almost always return zero results.
- No \`site:\` filters unless you've confirmed the domain has what you want. Let the search engine rank authoritative sources (arxiv, official docs, .edu) on its own.
- No dates unless the query is specifically time-sensitive.
- Each query should be a single conceptual angle — if you catch yourself AND-ing two ideas, split into two queries.

Quality bar: 3–4 well-shaped queries beat 5 over-specified ones. Broad beats narrow.`;

function requirementsIsEmpty(req: PlanRequirements): boolean {
  return (
    req.wordCountMin === null &&
    req.wordCountMax === null &&
    !req.form &&
    !req.audience &&
    !req.styleNotes
  );
}

export function deepSearchPlannerPrompt(
  task: string,
  sources: SourceMeta[],
  priorQueries: string[],
  hints: string[],
  requirements: PlanRequirements | null = null,
): string {
  const hintsBlock =
    hints.length === 0
      ? ''
      : `\n\nUser steering hints (high-priority directions — bend the next queries toward these):\n${hints
          .map((h, i) => `${i + 1}. ${h}`)
          .join('\n')}`;
  const priorBlock =
    priorQueries.length === 0
      ? '(none yet)'
      : priorQueries.map((q) => `- "${q}"`).join('\n');
  const requirementsSection =
    requirements && !requirementsIsEmpty(requirements)
      ? `\n\nTask requirements (the writing constraints behind this research — bend queries toward the form and audience):\n${requirementsBlock(requirements)}`
      : '';

  return `You are the research query generator for Myst's Deep Search — a research-only mode that finds and ingests sources into the user's wiki without touching what they're writing. Your ONLY job is to emit the next batch of web searches — no prose, no chat.

Research task: "${task}"${requirementsSection}

Sources already in wiki:
${sourcesBlock(sources)}

Queries already run:
${priorBlock}${hintsBlock}

Propose the next 3–4 web searches. Prefer primary sources (papers, official docs, firsthand accounts) over secondary commentary. Do NOT repeat queries already run.

${QUERY_STYLE}

Output ONLY a fenced \`research_plan\` block. No text before or after.

\`\`\`research_plan
[
  {"query": "...", "rationale": "why this matters"}
]
\`\`\`

If the wiki already covers the task, emit an empty array \`[]\`.`;
}

/* ────────────────────── Pre-draft lookup + one-shot ────────────────────── */

/**
 * Pre-draft lookup pass. The model reads requirements + plan.md + wiki
 * summaries, and emits `source_lookup` fences for any anchors / source
 * pages / raw files it wants verbatim before committing to the draft.
 */
export function preDraftLookupPrompt(
  session: DeepPlanSession,
  sources: SourceMeta[],
  detailedSummaries: Map<string, string>,
  docLabel: string,
): string {
  return `You are Myst's pre-draft researcher. The next step is a one-shot draft of "${docLabel}" from a completed Deep Plan session — but BEFORE that draft runs, you get one pass to pull any verbatim source passages you think will make the draft sharper. The draft model will see everything you pull, pre-fetched, with no further chance to look anything up.

Your ONLY job right now is to decide which anchors (and optionally which full source pages) to pull. You are NOT writing the draft in this turn.

User's task: "${session.task}"

Task requirements (the draft will be judged against these):
${requirementsBlock(session.requirements)}

plan.md (what the drafter will write from — read it and ask yourself which sources it leans on hardest):

${planBlock(session.plan)}

Wiki — sources with full detailed summaries and anchor labels:

${richSourcesBlock(sources, detailedSummaries)}

${DEEP_REFERENCE_RIDER}

Think about the draft the plan above implies, then ask yourself:
- Which specific claims, numbers, definitions, or arguments will the draft lean on hardest? Pull those anchors.
- Are there quotes that would carry a point better verbatim than paraphrased? Pull those.
- Are there sources whose one-paragraph summary feels thin for what the plan demands? Pull the full source page.
- Are there anchors whose labels look important but whose exact wording you can't reconstruct? Pull them.

Budget guidance:
- Pulling 5-15 anchors is typical and cheap. Don't be shy — lookups are free and the draft model will thank you.
- Don't pull anchors you won't use. Don't pull every anchor reflexively.
- Prefer specific anchors over whole source pages unless the summary is genuinely insufficient.

Output ONLY source_lookup fences (one block per lookup), and nothing else. No prose, no explanation, no draft. Example:

\`\`\`source_lookup
{"slug": "smith-attention", "anchor": "law-1-2"}
\`\`\`

\`\`\`source_lookup
{"slug": "vaswani-2017", "anchor": "main-finding"}
\`\`\`

If the detailed summaries are genuinely sufficient and no verbatim text would help, output nothing at all — an empty response is valid.

---

[Prose-style / commands guide, applies to the draft that will run after this pass. You don't need to act on it now; it's here so your anchor selections match what the drafter will actually want to quote. The drafter will re-receive this guide.]

${DEEP_PLAN_COMMANDS}`;
}

export function oneShotPrompt(
  session: DeepPlanSession,
  sources: SourceMeta[],
  detailedSummaries: Map<string, string>,
  prefetchedPassages: string,
  docLabel: string,
): string {
  const passagesBlock = prefetchedPassages.trim()
    ? `\nPre-fetched verbatim passages (pulled from the wiki off-disk for this draft — these are EXACT text, safe to quote directly):\n\n${prefetchedPassages.trim()}\n`
    : '';

  return `[HARD RULES. These override everything below, including the writing-style guide. Violating these is a bug, not a stylistic choice.]
- ZERO em dashes (—) in the final draft. Not one. Not "just stylistically". Not in quotes you're paraphrasing. If you feel the urge to use one, choose: a period (two sentences), a comma clause, parentheses, or a colon. Em dashes are the single strongest AI-prose tell and we do not ship them.
- Do not use en dashes (–) as a substitute. A regular hyphen (-) is fine inside compound modifiers; for sentence-level breaks use the alternatives above.
- EVERY non-trivial claim cites a source, inline, at the point the claim is made. A non-trivial claim is any factual statement, attribution, historical fact, date, statistic, definition, critique, named position, or interpretive argument. The only uncited sentences permitted are: (a) your own reasoning and framing, (b) logical connectives and transitions, (c) restatements of the user's own prompt. If you cannot cite it from the wiki below, omit it — never assert an un-sourced fact. A sparsely-cited draft is a failed draft.
- HONOUR THE WORD-COUNT RANGE in the requirements below. This is a contract. Going over or under by more than 10% is a failure — use the plan's section breakdown to budget your words before you start writing.

You are Myst, writing the first full draft of "${docLabel}" from a completed Deep Plan session. You are an informed essayist, not a summariser of summaries. The wiki below is your knowledge base; treat it the way a good researcher would treat a pile of open books at their elbow: read it, wander it, quote from it, find the tensions between sources.

User's task: "${session.task}"

Task requirements (HARD constraints — the draft is judged against these):
${requirementsBlock(session.requirements)}

plan.md — the distilled output of the whole Deep Plan session. Treat this as your marching orders: follow its structure, cite the sources it names, honour its thesis:

${planBlock(session.plan)}

Wiki (sources with full detailed summaries and key anchor labels):

${richSourcesBlock(sources, detailedSummaries)}
${passagesBlock}
How to approach this draft (read carefully):

1. **Follow plan.md.** The plan is the distillation of an entire adversarial-panel session. Its structure, thesis, and source attributions were chosen deliberately — don't reinvent them. If the plan names a section, write that section. If the plan names a source for a claim, use that source.
2. **Read the wiki first.** The detailed summaries above are not one-liners; they're multi-paragraph reads of each source. Hold them in mind before committing to a paragraph.
3. **Follow ideas across sources.** A concept raised in one source is usually echoed, refined, or contested in another. Name those connections.
4. **Find tensions.** If two sources pull in different directions on the same question, say so, frame the disagreement, and take a position (guided by the plan's thesis).
5. **Quote sparingly but precisely.** When you do quote a source directly, prefer the pre-fetched verbatim passages above when present. Otherwise only quote text that actually appears in the detailed summaries. Do not fabricate quotes.
6. **Counter-argument pass.** Briefly address the strongest objection to the thesis before rebutting or conceding.

Citation format (strict):
Any claim carrying facts, numbers, arguments, or positions must be inline-cited as a parenthesised markdown link to the slug. The citation is just the source name inside round brackets, nothing else:
   ([Name](slug.md))
where **Name** is the source's short label (first-author surname if a paper, or a short sensible label otherwise). Example: \`([Michael](michaelpaper.md))\`. The surrounding parentheses are required; never emit a bare \`[Name](slug.md)\` without them. Do NOT include a year; we'd rather have no year than a wrong one. Do NOT wrap citations in backticks. Do NOT append \`#anchor\` fragments or any other suffix to the slug; just the plain \`slug.md\` link. Descriptive or connective prose can go uncited; err on the side of citing.

Referencing discipline (strict):
- Cite ANY time you mention something that traces to a source: a claim, a number, a definition, a framing, an argument, an example, a historical fact, a quoted term of art, a named person's position. Paraphrasing does not remove the obligation to cite; if you learned it from a source in the wiki above, cite that source. Uncited prose should be limited to your own reasoning, transitions, and connective tissue.
- If a single sentence draws on more than one source, emit more than one inline citation, adjacent: \`([Smith](smith.md)) ([Jones](jones.md))\`.
- End the draft with a \`## References\` section (sentence case, no other heading variations). List only sources that were actually cited in the body. Format each entry **Harvard style** on its own line as a markdown bullet:
    - \`Author(s) (Year) *Title*. Publisher or outlet. Available at: URL.\`
  Use whatever bibliographic detail is visible in the detailed summary for that source (author names, publication year, title, outlet, URL). Do NOT invent missing fields: if year is unknown, omit it; if author is unknown, lead with the title; if there is no URL, omit "Available at:". Every entry MUST end with a markdown link to the slug itself, written as a trailing parenthesised \`([slug.md](slug.md))\` so the reference remains clickable inside Myst even when bibliographic fields are thin.
- Alphabetise the references section by the leading author surname (or title, when author-less). One bullet per source. Do not repeat the same source twice.
- Sources that you did not actually cite in the body must NOT appear in References.

Form + output rules:
- Hit the requirements above — length, form, audience. The word-count range is the single most important constraint.
- No preamble, no "Here is your draft:", no meta-commentary. Start with the title or opening line and write the full piece straight through.
- Use proper markdown: \`#\` headings, \`**bold**\`, \`*italic*\`, blank lines between paragraphs.
- Do NOT make up sources, slugs, or quotes. If a source isn't in the wiki above, it doesn't exist for this draft.

Output: the complete markdown draft, nothing else.

---

Prose style / commands (read and internalise before you write a single word). This is the bar the draft has to clear. Remember: the HARD RULES at the very top of this prompt, and the citation format above, dominate any tension with the prose guide below.

${DEEP_PLAN_COMMANDS}`;
}
