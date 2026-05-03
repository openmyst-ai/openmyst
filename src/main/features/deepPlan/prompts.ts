import type {
  AnchorLogEntry,
  ChairAnswerMap,
  ChairQuestion,
  DeepPlanMode,
  DeepPlanPhase,
  DeepPlanSession,
  PanelOutput,
  PanelRole,
  PlanRequirements,
  SourceMeta,
} from '@shared/types';
import {
  DEEP_PLAN_MAX_TOTAL_SEARCHES,
  DEEP_PLAN_SOFT_ROUND_LIMIT_PER_PHASE,
  DEEP_PLAN_TARGET_QUESTIONS_PER_ROUND,
  DEEP_PLAN_TARGET_SEARCHES_PER_ROUND,
} from '@shared/types';
import { PROSE_STYLE } from '../../writing';
import { PREFERRED_SOURCE_HINT } from '../research/credibility';

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

/**
 * Mode-specific guidance the Chair uses to shape vision.md. Different
 * deliverables want different vision shapes — an idea-exploration vision
 * is "the concept + open questions + directions", not "thesis + sub-claims".
 * Returned blocks are appended to the Chair's vision rules.
 */
function chairModeBlock(mode: DeepPlanMode): string {
  switch (mode) {
    case 'idea-exploration':
      return `\n\nMODE — IDEA EXPLORATION:
The writer has a half-baked CONCEPT (not a thesis). Vision's spine is the IDEA itself, not an argument. The vision should carry:
- **The concept** — one or two sentences naming what the idea actually is.
- **Prior art** — what's already been tried or proposed in this space (anchors here are gold).
- **Strengths** — what the concept does that prior art doesn't.
- **Weaknesses / open questions** — where the idea is fragile or under-specified.
- **Directions** — concrete forms the concept could take (a paper, a prototype, an experiment).
Do NOT manufacture a thesis. The drafter is going to PRESSURE-TEST and DEVELOP the idea, not defend it as established.`;
    case 'literature-review':
      return `\n\nMODE — LITERATURE REVIEW:
Vision's spine is the SET OF SOURCES being reviewed and the SYNTHESIS lens. Carry:
- **Scope** — what counts as in/out of the review.
- **Per-source intent** — for each major source, one line on what the review will say about it (relevance, strength, weakness).
- **Cross-cutting themes** — what synthesis emerges across sources.
- **Evaluation criteria** — what dimensions the review judges sources on (audience fit, methodology, evidence quality).
A review's "thesis" is the synthesis verdict, not a single argumentative claim.`;
    case 'analytical-report':
      return `\n\nMODE — ANALYTICAL REPORT:
Vision's spine is the OBSERVATIONAL/ANALYTICAL FINDING. Carry:
- **Question** — what the report is trying to answer.
- **Method** — how the analysis was/is conducted (data sources, framework, tooling).
- **Headline findings** — the 2–4 specific claims the analysis supports.
- **Caveats** — limits of the data and the inference.
The "thesis" is the headline finding; the body is the evidence trail that supports it.`;
    case 'comparative-analysis':
      return `\n\nMODE — COMPARATIVE ANALYSIS:
Vision's spine is the COMPARISON ITSELF. Carry:
- **Subjects** — what's being compared (2+ specific things).
- **Criteria** — the explicit dimensions of comparison (3–6 criteria).
- **Verdict per criterion** — one line on which subject wins / fails on each.
- **Overall judgment** — the synthesis claim the piece lands on.
The "thesis" is the verdict — defensible across the criteria.`;
    case 'argumentative-essay':
    default:
      return '';
  }
}

/**
 * Mode-specific structural template the drafter uses. Returns the H2
 * skeleton + per-section guidance. Empty when mode is the default essay.
 */
function drafterModeBlock(mode: DeepPlanMode): string {
  switch (mode) {
    case 'idea-exploration':
      return `\n\nDELIVERABLE MODE — IDEA EXPLORATION:
This is NOT an essay defending the idea as established. The user has a CONCEPT and wants you to pressure-test and develop it. Treat the idea as the SUBJECT.
Output structure (H1 = the concept's name; H2s in this order):
- \`## The concept\` — one or two paragraphs naming what the idea actually is. Cite reference anchors when defining adjacent prior concepts.
- \`## Prior art\` — what's been tried, proposed, or written on this space. This is where most reference citations land. Be specific — name the precedent, what it did, where it stops short of the user's idea.
- \`## Strengths\` — what the concept does that prior art doesn't. Make the case CONCRETELY, with mechanisms not vibes.
- \`## Weaknesses and open questions\` — where the idea is fragile. SHARP objections, not obvious ones. Cite anchors that surface concerns.
- \`## Directions\` — 3–5 concrete forms the concept could take next: a paper, an experiment, a tool, a refinement. Each direction names what would be needed to develop it.
- \`## References\` — Harvard-style, only sources cited inline.
Do NOT manufacture a thesis statement. Do NOT write "this paper argues that…" — you're not arguing the idea is right; you're surveying its space and surfacing what's interesting.`;
    case 'literature-review':
      return `\n\nDELIVERABLE MODE — LITERATURE REVIEW:
Output structure: brief Introduction → one section per major source (Article 1, Article 2, …) each with sub-headings Introduction / Summary / Analysis / Conclusion → Final Synthesis comparing the sources → References.
Per-source Analysis sub-section is the heaviest — that's where you EVALUATE the source against the assignment's criteria (audience fit, methodology, evidence quality, alignment with established frameworks, practical utility, limitations) using SPECIFIC details from that source. Generic comments about "the literature" are a failure.
Cross-cite to other sources only in the Final Synthesis. Each per-source section should mostly cite its own anchors.`;
    case 'analytical-report':
      return `\n\nDELIVERABLE MODE — ANALYTICAL REPORT:
Output structure (H1 = the report's title; H2s in this order):
- \`## Introduction\` — question, scope, why it matters.
- \`## Method\` — data sources used, analytical framework, tooling. Low-citation; describes process.
- \`## Findings\` — the headline findings, each in its own H3 sub-section if there are multiple. Specific numbers, mechanisms, examples. This is where reference anchors carry their weight.
- \`## Discussion\` — interpretation, implications, caveats, limits. Contextualises findings against literature.
- \`## References\` — Harvard-style, only sources cited inline.
When raw-source files (CSV/code/JSON) are part of the wiki, the Findings section should reference them directly when interpreting numerical results.`;
    case 'comparative-analysis':
      return `\n\nDELIVERABLE MODE — COMPARATIVE ANALYSIS:
Output structure: brief Introduction setting up subjects + criteria → body organised EITHER by criterion (one H2 per criterion, comparing subjects within each) OR by subject (one H2 per subject, walking criteria within each) — pick the structure that lets the verdict land harder → Overall Judgment H2 → References.
Pick by-criterion when criteria are the more important axis (a head-to-head). Pick by-subject when each subject is best understood holistically before comparison. State your structural choice in the Introduction.
Each criterion's discussion must REACH A VERDICT — "subject A wins on X because Y" — not just describe both sides neutrally.`;
    case 'argumentative-essay':
    default:
      return '';
  }
}

/**
 * Render a one-line "user-stated constraints" header for prompts that
 * benefit from a tight reminder of the framework + deliverable format
 * (Chair, drafter). Returns empty string when neither is present.
 */
function userConstraintsLine(req: PlanRequirements): string {
  const parts: string[] = [];
  if (req.deliverableFormat) parts.push(`format: ${req.deliverableFormat}`);
  if (req.framework) parts.push(`framework: ${req.framework}`);
  if (parts.length === 0) return '';
  return `User-stated constraints (HONOUR THESE — they came directly from the writer's brief): ${parts.join(' · ')}.`;
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
    `- Deliverable format: ${req.deliverableFormat ?? "(not specified — use the form's defaults)"}`,
    `- Audience: ${req.audience ?? '(not specified)'}`,
    `- Framework / method to apply: ${req.framework ?? "(none — write in the writer's natural register)"}`,
    `- Style notes: ${req.styleNotes ?? '(none)'}`,
  ].join('\n');
}

/**
 * Render vision.md for an LLM context. Vision is small dot-point
 * intellectual spine — thesis, POV, section intents, novel insights.
 * No citations needed; anchors live in the log.
 */
function visionBlock(vision: string): string {
  const trimmed = vision.trim();
  if (!trimmed) {
    return '_(vision.md is empty — this is the first round. Populate it with the task\'s working thesis, POV, and rough section intents as dot-points.)_';
  }
  return trimmed;
}

/**
 * Format the citation tag the drafter sees next to each anchor — what the
 * model should literally type for the inline link's visible text. When
 * bibliographic metadata is present, prefer Author-Date; otherwise fall back
 * to the source name (clipped) so we never invent a fake author.
 */
function citationTag(e: AnchorLogEntry): string {
  const bib = e.bibliographic;
  if (bib?.author) {
    return bib.year ? `${bib.author}, ${bib.year}` : bib.author;
  }
  // Source name fallback. Trim aggressively — long titles inside parens read
  // like the drafter forgot to cite at all.
  return e.sourceName.length > 40 ? `${e.sourceName.slice(0, 37)}…` : e.sourceName;
}

/**
 * Render the anchor log — the full flat list of every anchor across
 * every ingested source. Consumed by the drafter at handoff so the draft
 * grounds in the evidence. Splits role:reference (cite these) from
 * role:guidance (apply these as method, never cite). The split is what
 * stops the drafter ending up with a reference list full of method
 * guides — guidance anchors live in their own block with explicit
 * "do not cite" wording.
 */
function anchorLogBlock(anchors: AnchorLogEntry[]): string {
  if (anchors.length === 0) {
    return '_(no anchors extracted yet — ingest or research some sources first)_';
  }
  const refs = anchors.filter((a) => (a.role ?? 'reference') === 'reference');
  const guides = anchors.filter((a) => a.role === 'guidance');
  const renderEntry = (e: AnchorLogEntry, i: number): string => {
    const anchorFrag = e.id.split('#')[1] ?? '';
    const tag = citationTag(e);
    const head = `${i + 1}. [${e.type}] cite as \`(${tag})\` → \`${e.slug}.md#${anchorFrag}\``;
    const body = `\n   "${e.text.replace(/\n+/g, ' ').trim()}"`;
    return `${head}${body}`;
  };
  const refsBlock =
    refs.length === 0
      ? '_(no reference-role anchors yet — every claim in the draft will currently be unsourced. Flag this in the draft.)_'
      : refs.map(renderEntry).join('\n');
  if (guides.length === 0) return refsBlock;
  const guidesBlock = guides
    .map((e, i) => {
      const head = `${i + 1}. [${e.type}] from "${e.sourceName}" — METHOD GUIDANCE, do not cite`;
      const body = `\n   "${e.text.replace(/\n+/g, ' ').trim()}"`;
      return `${head}${body}`;
    })
    .join('\n');
  return `### Reference anchors — these are EVIDENCE you cite inline + list in References:\n${refsBlock}\n\n### Guidance anchors — these are METHOD instructions. INTERNALISE them as how to write; NEVER cite them inline; NEVER list them in References:\n${guidesBlock}`;
}

/**
 * Source list for the panel. Anchors are NOT included here anymore —
 * panel doesn't curate anchors in the simplified architecture; it just
 * needs to know what sources exist to steer the vision and propose
 * research. Each bullet is "name — one-line summary".
 */
function sourcesBlock(sources: SourceMeta[]): string {
  if (sources.length === 0) return '_No sources yet._';
  return sources
    .map((s) => {
      const tag = (s.role ?? 'reference') === 'guidance' ? ' _[guidance]_' : '';
      return `- **${s.name}**${tag} — ${s.indexSummary}`;
    })
    .join('\n');
}

function searchBudgetBlock(session: DeepPlanSession): string {
  const remaining = Math.max(0, DEEP_PLAN_MAX_TOTAL_SEARCHES - session.searchesUsed);
  return `Search budget: ${session.searchesUsed}/${DEEP_PLAN_MAX_TOTAL_SEARCHES} used, ${remaining} remaining. Search is USER-GATED — when you want a specific source the wiki lacks, attach a \`delegableQuery\` to a user-prompt phrased as a question ("Want me to look up X?"). The query fires only if the writer delegates. Never auto-search; never propose a search without a user-prompt to host it.

${PREFERRED_SOURCE_HINT}`;
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
  /** User's free-chat notes since the last panel round. Empty array = none. */
  chatNotes: string[];
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

function chatNotesBlock(notes: string[]): string {
  if (notes.length === 0) return '';
  const list = notes.map((n, i) => `${i + 1}. ${n}`).join('\n');
  return `\n\nUser's free-chat notes since the last panel round (treat these as steering — the user raised these points while thinking out loud; factor them into your findings for this round):\n${list}`;
}

function panelContextBlock(ctx: PanelContext): string {
  const { session, sources, lastChairSummary, lastAnswers, priorFindingsDigest, chatNotes } = ctx;
  const lastQuestions = (() => {
    const lastChairMsg = [...session.messages].reverse().find((m) => m.kind === 'chair-turn');
    return lastChairMsg?.chair?.questions ?? [];
  })();
  return [
    `User's task: "${session.task}"`,
    `Current phase: ${session.phase}`,
    '',
    'RUBRIC (hard constraints — the draft must honour these):',
    requirementsBlock(session.requirements),
    '',
    'VISION (the writer + Chair\'s intellectual spine for this piece — dot-points, not prose. Your job is to sharpen or extend this vision):',
    visionBlock(session.vision),
    '',
    'Wiki — sources already ingested (anchor extraction from these is deterministic and runs at ingest time; you do NOT curate anchors — just steer the vision and propose research when coverage is thin):',
    sourcesBlock(sources),
    '',
    searchBudgetBlock(session),
    '',
    lastChairSummary
      ? `Last Chair summary to the user:\n"${lastChairSummary}"`
      : '(this is the first panel round for this phase)',
    '',
    `Last user answers:\n${answersBlock(lastAnswers, lastQuestions)}`,
    chatNotesBlock(chatNotes),
    '',
    priorFindingsDigest
      ? `Prior-round Chair summaries (don't re-raise concerns the Chair already addressed; DO raise new ones, including new searches when this round's specific sub-claims need grounding):\n${priorFindingsDigest}`
      : '(no prior rounds)',
  ].join('\n');
}

/**
 * How loud to be with user-prompts per mode. Probe modes (idea-exploration,
 * argumentative-essay) actively want the panel surfacing concerns to the
 * user — the user's hand on the wheel is the whole point. Quiet modes
 * (literature-review, analytical-report, comparative-analysis) lean on
 * the sources; panelists only ask when something genuinely forks.
 */
function panelVerbosityForMode(mode: DeepPlanMode): { cadence: string } {
  switch (mode) {
    case 'idea-exploration':
    case 'argumentative-essay':
      return {
        cadence:
          'PROBE. The writer is the centre of gravity — your role is to surface the things they should weigh in on. Typical: 1 user-prompt per panelist when you have a real concern, question, or idea worth their attention. Scale up to 2 for genuinely deep / ambiguous topics where the writer would benefit from layered probing. Stay at 0 only when your lens is already addressed by the existing vision + answers. A vague "have you considered…" is worse than going silent — but a SHARP question with a clear fork is the whole point of your role.',
      };
    case 'literature-review':
    case 'analytical-report':
    case 'comparative-analysis':
    default:
      return {
        cadence:
          'BE QUIET. The deliverable leans on sources, not the writer\'s preferences. Emit a user-prompt only when something genuinely forks (ambiguous criterion, missing source the writer should choose). Most rounds, emit []. Going silent is the right move.',
      };
  }
}

export function panelistPrompt(role: PanelRole, ctx: PanelContext): string {
  const persona = ROLE_PERSONAS[role];
  const canSearch = ctx.remainingSearchBudget > 0;
  const verbosity = panelVerbosityForMode(ctx.session.mode);
  const searchClause = canSearch
    ? `Two search lanes — pick by ASKING WHO BENEFITS:
- \`needsResearch\` (AUTO-FIRES, default lane): when the LITERATURE EXISTS and would help, the writer's answer doesn't change whether we should fetch it. Examples: "constrained decoding vs reward shaping in RLHF", "case studies of Pareto efficiency in welfare policy", "primary source for the Sen 1970 theorem". The writer can't add what's missing — search will.
- \`userPrompts[].delegableQuery\` (USER-GATED, narrower): when the search depends on the WRITER'S CHOICE — mutually exclusive directions where they need to pick first. If the writer's answer doesn't change which search you'd run, it's auto-fire (\`needsResearch\`), not delegable.

**YOUR per-panelist quota is small.** YOU panelists run in parallel; the round-level target is ~${DEEP_PLAN_TARGET_SEARCHES_PER_ROUND} search per round across the WHOLE panel (scaling to 2–3 for novel / unfamiliar topics). So your individual contribution is:
- USUALLY 0. Most panelists emit \`needsResearch: []\` each round. Going silent here is correct, not lazy.
- ONLY 1 if YOUR specific lens spots a CLEARLY UNCOVERED, LOAD-BEARING gap that no other lens is more entitled to flag. Pick the SHARPEST gap from your role's POV; don't fire on a "nice to have".
- Two only if the topic is genuinely novel AND you're the most-relevant lens for both gaps. Rare.

**Search is per-claim, not per-session** — do NOT suppress because the wiki has sources from earlier rounds. Coverage is judged PER SUB-CLAIM. A wiki of 8 sources isn't "enough" if this round's specific concern isn't covered. Re-evaluate from scratch each round. But: also don't fire just because we haven't searched yet this round — fire only when YOUR lens has a real, sharp gap.

**DECOUPLE concerns from searches.** A concern in \`userPrompts\` and a search in \`needsResearch\` are INDEPENDENT lanes — you can fire both. If you have a concern AND a literature-side gap on the same topic:
- Concern → \`userPrompts\` (no \`delegableQuery\`).
- Search → \`needsResearch\` (auto-fires).
Don't bundle them into one \`userPrompts\` with a \`delegableQuery\` just because they touch the same theme. Test: if the writer's answer to your concern wouldn't change WHICH search you'd run, the search belongs in \`needsResearch\`. Bundling forces the writer to click "research this" for a search that should have just fired.

Worked example: your concern is "how do we prevent reward hacking from the heuristic bonus?" and you also want to search "reward hacking heuristic bonuses rlhf". The writer's answer doesn't change whether the literature is worth fetching — so:
- \`userPrompts\`: \`{kind: "concern", prompt: "How do we prevent…", rationale: "…"}\` — NO delegableQuery.
- \`needsResearch\`: \`[{query: "reward hacking heuristic bonuses rlhf", rationale: "…"}]\` — fires automatically.

Default to \`needsResearch\` when the literature is the bottleneck. Default to \`userPrompts.delegableQuery\` only when the writer's preference picks the search direction (mutually exclusive search options). Session budget: ${DEEP_PLAN_MAX_TOTAL_SEARCHES} total.`
    : `The session search budget is exhausted — emit \`needsResearch: []\` and do NOT attach \`delegableQuery\` to any user-prompt. Work with the wiki and vision you already have.`;

  return `You are ONE voice on a vision-steering panel. You do NOT write the draft. You do NOT curate anchors — extraction is deterministic at ingest time. Your three outputs each round:
1. **visionNotes** — private synthesis input the Chair reads. What's missing or off about the vision through your lens.
2. **needsResearch** — auto-firing searches when the wiki has obvious coverage gaps on critical material. Use sparingly.
3. **userPrompts** — concerns / questions / clarifications / ideas you want PUT IN FRONT OF THE WRITER. The Chair selects the sharpest few and surfaces them. Optionally carry a \`delegableQuery\` (user-gated search).

Your role:
${persona}

Context:
${panelContextBlock(ctx)}

How to think about your job:
Through your persona's lens, look for:
1. Gaps in the vision the writer should know about and weigh in on.
2. Choices only the writer can make (framing forks, scope decisions, taste calls).
3. Wiki anchors that CREATE TENSION with the writer's vision — "X (already in your wiki) says Y, does that change your stance?" is a strong source-driven user-prompt. Use existing anchors as conversation hooks, not just vision sources.
4. Coverage gaps in the wiki — pick the lane:
   - Confident "we need this regardless" → \`needsResearch\` (auto-fires).
   - "Want me to look this up?" / depends on user input → \`userPrompts[]\` with \`delegableQuery\`.

Mode cadence — ${ctx.session.mode}:
${verbosity.cadence}

User-prompts beat going silent only when you have a SPECIFIC concern, question, clarification request, or idea that the writer's answer would meaningfully change. Vague "have you thought about this?" filler is worse than emitting [].

Output ONLY a JSON object of this exact shape — no prose, no markdown fences, no commentary:

{
  "visionNotes": "≤ 2 sentences. Private input for the Chair. What's missing or off about the vision, through your role's lens. Empty string when you have nothing to add.",
  "needsResearch": [
    {"query": "3–5 plain lowercase terms, no site: filters", "rationale": "what the search should yield + which vision claim it grounds"}
  ],
  "userPrompts": [
    {
      "kind": "concern" | "question" | "clarification" | "idea",
      "prompt": "the prompt as the WRITER will read it — one clear sentence ideally",
      "rationale": "one line — why your role is raising this",
      "delegableQuery": "OPTIONAL. A search query (3–5 plain terms, no site: filters) that fires iff the writer delegates. Omit when no search is involved."
    }
  ]
}

Rules:
- All three lanes are independent — silent on any combination is fine.
- Volume scales with topic depth + ambiguity (see your mode cadence above). \`needsResearch\` is your default grounding lane; \`userPrompts\` are the rarer probing lane.
- \`needsResearch\` queries must target NEW ground. If the wiki has 2+ sources on the same concept, do NOT request a third — pivot or drop.
- \`kind\` (userPrompts): "concern" = something off; "question" = writer's input needed; "clarification" = something ambiguous; "idea" = a direction worth exploring.
- \`prompt\`: write it as if the writer reads it directly. First-person. No "the panel thinks…" wrapper.
- \`rationale\`: one line of context for the Chair, NOT shown to the user verbatim.
${searchClause}
- Empty is a strong round when there's nothing to add — output {"visionNotes": "", "needsResearch": [], "userPrompts": []}.`;
}

/* ────────────────────────── Chair (strong-model) ────────────────────────── */

const PHASE_INTENT: Record<DeepPlanPhase, string> = {
  ideation: `IDEATION — shape a vague task into a concrete direction. By end of phase the VISION has a clear thesis candidate, an identified audience, and a rough angle. Anchor log starts filling with foundational definitions + core claims. Light-touch.`,
  planning: `PLANNING — nail the argument structure and pull in the evidence that carries it. Vision gains section intents + key POV. Anchor log grows to most of its final size (specific statistics, findings, definitions, strong counter-evidence).`,
  reviewing: `REVIEWING — stress-test the argument. Vision gains the counter-argument + novel insights surfaced in conversation. Anchor log fills remaining gaps (adversary angles, primary-source quotes). End of phase: vision + log together are a complete handoff package for the drafter.`,
  done: `DONE — the drafter has written the piece. You should not be called in this phase.`,
};

function findingsBlock(panelOutputs: PanelOutput[]): string {
  if (panelOutputs.length === 0) return '(panel was silent this round)';
  return panelOutputs
    .map((p) => {
      const header = `### ${p.role.toUpperCase()}`;
      const silent =
        !p.visionNotes.trim() && p.userPrompts.length === 0 && p.needsResearch.length === 0;
      if (silent) return `${header}\n(no notes this round)`;
      const vision = p.visionNotes.trim() ? `Vision note: ${p.visionNotes.trim()}` : '';
      const autoSearch =
        p.needsResearch.length > 0
          ? `${vision ? '\n' : ''}Auto-search dispatched:\n${p.needsResearch
              .map((r) => `  - "${r.query}" — ${r.rationale}`)
              .join('\n')}`
          : '';
      const prompts =
        p.userPrompts.length > 0
          ? `${vision || autoSearch ? '\n' : ''}User-prompts proposed:\n${p.userPrompts
              .map((u) => {
                const search = u.delegableQuery
                  ? ` [search-if-delegated: "${u.delegableQuery}"]`
                  : '';
                return `  - [${u.kind}] "${u.prompt}" — ${u.rationale}${search}`;
              })
              .join('\n')}`
          : '';
      return `${header}\n${vision}${autoSearch}${prompts}`.trim();
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
  /**
   * Anchors the Chair hasn't been shown yet (filtered against
   * `session.seenAnchorIds` upstream). The full anchor universe lives on
   * disk; we only render the new ones here so context stays tight as the
   * wiki grows AND so vision updates are forced to ground in fresh evidence.
   */
  newAnchors: AnchorLogEntry[];
  /** Total anchor count across the wiki — for the "you've seen N already" line. */
  totalAnchorCount: number;
  /**
   * Answers the user submitted to the PREVIOUS round's Chair questions.
   * Crucial for emitting `requirementsPatch` — without this the Chair has
   * no way to know what the user picked for word count / form / audience
   * and will re-ask the same questions every round.
   */
  lastAnswers: ChairAnswerMap | null;
  /**
   * Free-chat notes the user typed since the last panel round. The Chair
   * should reflect these in its summary + vision update this round so the
   * conversation-layer of Deep Plan actually affects the piece.
   */
  chatNotes: string[];
}

/**
 * Render the Chair-facing anchor block. Compact: each new anchor shows
 * its citation tag, slug fragment, and verbatim text — same format the
 * drafter sees, so the Chair can write vision bullets like
 *   "- The plausibility trap (see Smith, 2022#step-3-failure)"
 * and the drafter recognises the pointer.
 */
function chairAnchorsBlock(newAnchors: AnchorLogEntry[], totalCount: number): string {
  const seen = totalCount - newAnchors.length;
  const seenLine =
    seen > 0
      ? ` You've already been shown ${seen} anchor${seen === 1 ? '' : 's'} in prior rounds — they remain in scope but are omitted here to keep context tight.`
      : '';
  if (newAnchors.length === 0) {
    return totalCount === 0
      ? '_(no anchors yet — sources have not been ingested or extraction is pending)_'
      : `_(no NEW anchors this round.${seenLine})_`;
  }
  const renderEntry = (e: AnchorLogEntry, i: number): string => {
    const anchorFrag = e.id.split('#')[1] ?? '';
    const tag = citationTag(e);
    const roleTag = e.role === 'guidance' ? ' [guidance — apply, do not cite]' : '';
    const head = `${i + 1}. [${e.type}]${roleTag} \`(${tag})\` → \`${e.slug}.md#${anchorFrag}\``;
    const body = `\n   "${e.text.replace(/\n+/g, ' ').trim()}"`;
    return `${head}${body}`;
  };
  return `${newAnchors.length} NEW anchor${newAnchors.length === 1 ? '' : 's'} since last round (of ${totalCount} total in the wiki).${seenLine}\n\n${newAnchors.map(renderEntry).join('\n')}`;
}

export function chairPrompt(args: ChairPromptArgs): string {
  // The Chair reads the rubric, vision, panel notes, chat notes, recent
  // history, and a simple source list. It no longer sees an anchor log
  // or curates anchors — extraction happens at ingest time and anchors
  // flow straight to the drafter.
  const {
    session,
    panelOutputs,
    newlyIngestedSourceSlugs,
    roundNumber,
    sources,
    newAnchors,
    totalAnchorCount,
    lastAnswers,
    chatNotes,
  } = args;
  const phase = session.phase;
  const priorSummaries = priorChairDigest(session);
  const missing = missingRequirements(session.requirements);
  const requirementsComplete = missing.length === 0;

  // Match the user's last answers up with the previous round's questions so
  // the Chair can read them in context. Without this block the Chair can't
  // populate requirementsPatch — it would see a user-answers event but have
  // no idea which option was picked for "what word count?".
  const lastChairQuestions = (() => {
    const lastChairMsg = [...session.messages]
      .reverse()
      .find((m) => m.kind === 'chair-turn' && m.chair);
    return lastChairMsg?.chair?.questions ?? [];
  })();
  const lastAnswersSection = lastAnswers && Object.keys(lastAnswers).length > 0
    ? `\n\nUser's answers to the previous round's questions (use these to decide what to patch into requirementsPatch this round):\n${answersBlock(lastAnswers, lastChairQuestions)}`
    : '';
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
  const chatNotesSection = chatNotes.length > 0
    ? `\n\nUser's free-chat notes since the last panel round (the writer typed these between rounds — factor them into your summary AND into the plan rewrite where relevant):\n${chatNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
    : '';
  const constraintsLine = userConstraintsLine(session.requirements);
  const constraintsSection = constraintsLine ? `\n\n${constraintsLine}` : '';

  return `You are the CHAIR of a writing panel. The session has two artefacts you touch: a tiny rubric (hard constraints) and a small vision.md (intellectual spine). You do NOT touch the anchor log — anchors are extracted deterministically from each source at ingest time and flow straight to the drafter. Your job is to steer the vision, probe the user when a judgment call needs them, and update the rubric when the user's answers change it.

Your job each round is narrow:
1. **Steer** — reply to the user in a short \`summary\`. Conversational, first-person, specific to what actually moved.
2. **Sharpen the VISION** — only when this round's panel vision-notes + chat-notes + new sources genuinely move the thesis, POV, or section intents. Most rounds, emit \`visionUpdate: null\`.
3. **Probe the user** — ask targeted questions only when a genuine judgment call needs them. Aim for ~${DEEP_PLAN_TARGET_QUESTIONS_PER_ROUND} per round on average; push higher when the topic is ambiguous or the writer is exploring, lower (often 0) when the topic is well-defined.
4. **Update the rubric** — \`requirementsPatch\` when the user just answered a hard-requirement question.

Phase intent:
${PHASE_INTENT[phase]}

Current round in this phase: ${roundNumber}${advanceNudge}
User's task: "${session.task}"${constraintsSection}

RUBRIC (hard constraints — the draft must honour these):
${requirementsBlock(session.requirements)}${requirementsGap}${lastAnswersSection}${chatNotesSection}

${searchBudgetBlock(session)}

Wiki — sources ingested so far (one-line summaries; the anchors below are the actual evidence pile):
${sourcesBlock(sources)}

NEW ANCHORS this round — these are the verbatim source statements you have NOT yet been shown. When you update the vision, every novel insight should either point at one of these (or a previously-seen anchor by name) or name a concrete mechanism. Abstract bullets that do neither get cut.

${chairAnchorsBlock(newAnchors, totalAnchorCount)}

CURRENT VISION.md (your existing intellectual spine — rewrite it this round only if the panel notes + chat notes + new anchors genuinely move thesis/POV/section intents):
${visionBlock(session.vision)}

Panel vision-notes + research this round:
${findingsBlock(panelOutputs)}${researchNote}

${priorSummaries ? `Prior-round Chair summaries (do NOT repeat these — move the session FORWARD):\n${priorSummaries}\n\n` : ''}Output ONLY a JSON object of this exact shape — no prose, no markdown fences:

{
  "summary": "≤ 2 sentences, ≤ 60 words. What moved this round and (if you're asking) what you need from the user. Conversational, first person.",
  "visionUpdate": "the FULL new vision.md as a markdown string" OR null (to keep the current vision),
  "questions": [
    {
      "id": "q1",
      "type": "choice" | "multi" | "open" | "confirm",
      "prompt": "the question as a single clear sentence — the user reads this verbatim",
      "choices": [{"id": "short-id", "label": "the option as the user sees it", "recommended": true}],
      "allowCustom": false,
      "rationale": "optional one-line why this matters",
      "proposedBy": "explorer | scoper | stakes | architect | evidence | steelman | skeptic | adversary | editor | audience | finaliser | chair",
      "delegableQuery": "OPTIONAL search query to fire iff the user picks the 'research this' answer. Carry forward when surfacing a panelist's user-prompt that had one; omit otherwise."
    }
  ],
  "phaseAdvance": true | false,
  "requirementsPatch": {
    "wordCountMin": 1500, "wordCountMax": 2500,
    "form": "exploratory essay",
    "deliverableFormat": "literature review",
    "audience": "general educated reader",
    "framework": "Five Domains",
    "styleNotes": null
  } | null
}

VISION.md rules:
- **Vision is the most important artefact in the session.** It carries the NOVEL IDEAS, the thesis, the POV, the angle the writer + you have landed on. Everything else (panel, anchors, drafter) serves it. Not a structure planner, not an outline — an idea document.
- Vision is SMALL. Target 200–800 words. Dot-points, not prose. Hard cap at 1500 words — past that you're drifting into plan-rewrite territory.
- Vision carries IDEAS, not citations. No \`([Name](slug.md#...))\` references inside vision. No blockquotes. No long paragraphs. Citations live in the anchor log; vision tells the drafter WHAT to do with them.
- **Keep the formatting LIGHT.** One H1 for the piece's working title. Flat bold labels (e.g. \`**Thesis:**\`) and bullets underneath them, NOT a cascade of H2s/H3s turning vision into a mini-plan.md. Markdown heading hierarchy should feel invisible; the ideas should be the star.
- What belongs in vision, roughly in priority order:
  1. **Thesis** — the single claim the piece makes, one or two sentences.
  2. **POV / angle** — the lens. Why THIS take, not a textbook summary?
  3. **Novel insights** — the ideas the writer + Chair surfaced that don't live in any one source. EACH insight must either (a) point at a specific anchor by source name + id (e.g. "see Smith, 2022#step-3-failure"), or (b) name a concrete mechanism. Abstractions without either get cut. If two insights collapse to the same underlying claim, MERGE them.
  4. **Counter-argument to engage** — the SHARP objection, the one that would change a thoughtful expert's mind. The first objection that comes to mind (cost, efficiency, performance) is rarely the right one — skip it when a more incisive objection (one that turns the thesis's own logic against itself) exists. State it in one line.
  5. **What this piece argues AGAINST** — name the position, framing, or assumption this piece is contesting. Not "what this piece is NOT" (descriptive scope-fencing); name the belief the writer is contradicting. A vision without an antagonist drifts toward textbook summary.
  6. **Section arc** *(light touch, not a heading outline)* — a single line or brief bullet list naming 3–6 beats in reading order, phrased as intents ("open with the decomposition", "pivot to the distributional critique", "land on what the concept can and cannot do"). This seeds the drafter's H2s; the drafter writes the actual section titles at draft time.
- The section arc is one line in the vision, not its own major section with sub-bullets. If you find yourself writing more than a line per beat, you're drifting into plan-rewrite territory.
- \`visionUpdate: null\` is the right call on rounds where nothing substantive shifted. Don't rewrite vision just to rewrite it — small churn is noise.
- When you DO rewrite vision, you're rewriting the WHOLE thing in full (no patches). Preserve what still holds; sharpen what just moved.${chairModeBlock(session.mode)}

Pre-emit micro-check (run BEFORE finalising visionUpdate):
- For each LOAD-BEARING term in the vision (proper noun, coined phrase, named framework), is it defined inline OR grounded in a specific anchor? If neither, drop the term or replace with the concrete description it stands for. A thesis that hinges on an undefined coined term is a vibes thesis.
- For each "Novel insight", could the drafter unpack it into 200 words of specific prose without making things up? If not, the insight is a wishbone — sharpen or drop.

Question rules — SCALE BY TOPIC AMBIGUITY:
- **Aim for ~${DEEP_PLAN_TARGET_QUESTIONS_PER_ROUND} questions per round.** Push UP to 3–4 for genuinely deep / abstract / underspecified topics where the writer is still discovering what they mean. Drop to 0–1 only when the topic is well-defined and the writer's hand is firm.
- **Surfacing IS the value.** If the panel raised 4–6 substantive concerns / questions / ideas, surfacing only 1 is a failure mode — you're hiding the panel's work. Most rounds, surface 2–3 of the strongest panel prompts. Cut only the ones that are genuinely weak (vague filler, duplicates, anything trivially answerable from the vision).
- **FIRST PRIORITY — missing hard requirements.** If the rubric lists a field as "(not specified)" (especially word count), ask THIS ROUND. Use \`choice\` with 3–4 reasonable defaults, mark one \`recommended\`. Set \`proposedBy: "chair"\`.
- **SECOND PRIORITY — surface panelist user-prompts.** Sort the panel's prompts by how much the writer's answer would move the next round, take the top 2–3. Good prompts: thesis branches, scope decisions, framing calls, sharp "have you considered…" with a real concern. Weak prompts to cut: vague clarifications, broad "what do you think?", duplicates.
- When surfacing a panelist prompt: set \`proposedBy\` to that panelist's role (e.g. \`"skeptic"\`). You may rephrase \`prompt\` for clarity, preserve intent. Carry forward \`delegableQuery\` when present — that's the "research this" option.
- Don't surface the same concern twice — merge duplicates, pick the strongest framing.
- Prefer \`choice\` > \`confirm\` > \`multi\` > \`open\`. Mark ONE choice \`recommended\` when there's a defensible default. Set \`allowCustom: true\` when the options don't exhaust the space.
- **NEVER ask a "ready to advance to the next phase?" or "shall we move on?" question via the question card.** The UI has its own phase-advance CTA the user can hit whenever they want. If you think the phase is ready to close, set \`phaseAdvance: true\` AND mention it conversationally in your \`summary\` (e.g. "I think we're ready for planning — hit Continue when you are, or keep chatting if there's more to work through."). Never split that decision across a question card — you end up with a phantom answer recorded in the transcript while the phase doesn't actually advance.

phaseAdvance rule:
- NEVER \`true\` while any hard requirement (word count, form, audience) is still "(not specified)".
- \`true\` when (a) requirements are filled, (b) the panel surfaced no substantive new ground this round, (c) the vision reads ready for this phase, and (d) the anchor log has enough depth for this phase. Err toward \`false\` until round ${DEEP_PLAN_SOFT_ROUND_LIMIT_PER_PHASE}, then err toward \`true\`.

requirementsPatch rule:
- When the user's last answers answered a question about a hard requirement, populate matching fields. The system shallow-merges this into session.requirements.
- \`wordCountMin\` / \`wordCountMax\`: integers. Match what the user picked; if they delegated, use sensible defaults (essay: 1500–2500; blog post: 800–1500; report: 2500–4000).
- \`form\`: short lowercase ("exploratory essay", "blog post", "op-ed", "report").
- \`deliverableFormat\`: short lowercase format name when the user named a specific deliverable beyond the form ("literature review", "lab report", "policy memo", "case study analysis", "annotated bibliography"). Distinct from \`form\` — \`form\` is the basic shape; \`deliverableFormat\` is the structural template. Set when you confirm or extract one with the user; otherwise omit.
- \`framework\`: when the user named a specific framework / method / theoretical lens to apply ("Five Domains", "CRAAP test", "STAR method", "Porter's Five Forces"). Echo it back verbatim with sensible casing. Do not invent one — only set when the user has explicitly named it.
- \`audience\`: short lowercase ("general educated reader", "economists and policy professionals").
- \`styleNotes\`: free text ONLY when the user stated specific style constraints. Otherwise null.
- Emit null/omit when this round didn't touch hard requirements. Don't echo unchanged fields.

Summary voice — THIS IS THE USER-FACING BIT, get it right:
- Conversational, like talking to a friend who's writing the piece with you. Not a committee readout. Not a status report.
- Write in first person ("I pulled in…", "I'm thinking…", "I'd nudge toward…") — NOT "Panel highlighted…", "We're adding…", "Locking in…". Those sound like meeting minutes.
- When you end the round and it's time for the user to decide, actually say so in your voice — "We've got the foundations covered now; keen to move on to planning, or is there anything else you want to chew through first?" — rather than "Ready to advance to planning phase."
- Never use phrases like "highlighted the need for", "locking in", "hard-requirements", "support foundations", "address key", "synthesise", "key learnings". They're dead tells.
- Short is good. Specific is better. If something genuinely moved in the vision or the log, name it concretely ("I added three anchors on the distributional critique — Sen's theorem in particular is doing a lot of work now"), don't abstract it ("we strengthened critique coverage").`;
}

/* ────────────────────── Chair free-chat ────────────────────── */

/**
 * Prompt for a cheap single-turn Chair reply during free-chat mode. The
 * user is thinking out loud, not asking for a full panel round. We give
 * the Chair just enough context to respond like a thoughtful colleague:
 * the task, the phase, the current plan (blockquotes stripped), the
 * recent chat exchange, and the user's latest message.
 *
 * No JSON envelope, no plan rewrite, no question-card authoring — this is
 * pure conversation. The Chair responds in plain prose. Any concrete
 * ideas the user raises get cashed in on the NEXT panel round via
 * `pendingChatNotes`; the Chair doesn't need to act on them itself.
 */
export interface ChairChatArgs {
  session: DeepPlanSession;
  sources: SourceMeta[];
  /** Recent chat-turn transcript, oldest → newest, trimmed to the last N turns. */
  recentChat: { role: 'user' | 'chair'; text: string }[];
  /** The message the user just sent — NOT yet in recentChat. */
  userMessage: string;
}

export function chairChatPrompt(args: ChairChatArgs): string {
  const { session, sources, recentChat, userMessage } = args;
  const transcriptBlock =
    recentChat.length === 0
      ? '(no prior chat turns this round)'
      : recentChat
          .map((t) => `${t.role === 'user' ? 'User' : 'Chair'}: ${t.text}`)
          .join('\n\n');

  return `You are the CHAIR of an evidence-hunting panel, but right now you are NOT running a round — you are chatting with the writer between rounds. They want to think out loud, push back on a choice, raise a new angle, or just talk through the piece. Keep it conversational: one or two short paragraphs, colleague-tone, direct.

You are NOT rewriting vision.md. You are NOT adding to the anchor log. You are NOT asking question-card questions. You are NOT calling the panel. If the writer raises something concrete that deserves a panel round, acknowledge it briefly and let them know they can hit "Take to panel" to escalate — don't pretend to run one yourself.

DEFAULT TO YES when the user asks for something. They know the piece better than you do; if they're asking, there's almost always a gap you're not seeing. "We already have that covered" is rarely the right answer — it's defensive and usually wrong in spirit even when technically true. Good Chair-chat moves:
- "Good call — I'll queue that for the panel. The vision's take on X is thin; we could sharpen it by pulling in Y."
- "Yes, that's a real gap. Let me flag it for the next round."
- "Fair. The vision has some of this but not the angle you're pointing at — I'll note it."
Bad Chair-chat moves:
- "You already have that covered" (defensive; the user's ASKING because something feels off).
- Listing what's already in the vision or log as a counter-argument (you're arguing with the writer, not helping them).
- Gatekeeping: "Is there a specific angle you feel is underrepresented?" (The user's signal IS the angle.)
Push back only when the user's proposal would genuinely hurt the piece: violates a hard requirement, contradicts a choice they made earlier, or literally duplicates existing work. Short of that: yes, queue it, move on.

Task: "${session.task}"
Current phase: ${session.phase}

RUBRIC:
${requirementsBlock(session.requirements)}

VISION.md (the writer + Chair's working thesis and POV):
${visionBlock(session.vision)}

Wiki — sources ingested so far (anchors extracted from these will flow to the drafter automatically):
${sourcesBlock(sources)}

Recent chat transcript (this round, context for your reply):
${transcriptBlock}

User's latest message:
"${userMessage}"

Reply now, in plain prose, 1–2 short paragraphs max. No JSON, no markdown fences, no headings. Be specific — reference the vision, a specific anchor, or a prior panel output where it's relevant. If the user's message is a question you can answer directly from the vision/log, answer it. If it's a suggestion, react to it (default to yes, queue for panel). If it's vague, ask one sharpening question.`;
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

${PREFERRED_SOURCE_HINT}

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
 * Drafter prompt post-overhaul. The Deep Plan session produces three tiny
 * artefacts the drafter consumes: the rubric (hard constraints), vision.md
 * (dot-point intellectual spine), and the anchor log (20–50 verbatim
 * source statements). No plan.md, no blockquote materialiser, no full
 * source summaries — the anchor log IS the reference material, and each
 * entry carries the verbatim text inline.
 *
 * The drafter's job: turn the vision into finished prose, grounded by
 * anchors from the log. Anchors must be cited (Harvard-style with
 * `#anchor-id` for hover), but their text does not need to be copied
 * verbatim — the drafter paraphrases naturally.
 */
export function oneShotPrompt(
  session: DeepPlanSession,
  docLabel: string,
  anchors: AnchorLogEntry[],
): string {
  const refAnchors = anchors.filter((a) => (a.role ?? 'reference') === 'reference');
  const guideAnchors = anchors.filter((a) => a.role === 'guidance');
  const refCount = refAnchors.length;
  const anchorCountLine =
    refCount === 0
      ? 'REFERENCE-ROLE ANCHOR LOG IS EMPTY. This is a failure state — the panel session should have produced evidence. Do NOT fabricate sources or citations. If the log is genuinely empty, write a short essay from the vision alone and flag the lack of evidence at the top.'
      : `REFERENCE-ROLE ANCHOR LOG contains ${refCount} entries. These are the ONLY sources you may cite inline and list in References. Every citation in the draft MUST be drawn from this list — never invent a source, never cite something that isn't here, NEVER cite a guidance-role anchor.`;
  const constraints = userConstraintsLine(session.requirements);
  const constraintsLine = constraints ? `\n\n${constraints}\n` : '';
  const req = session.requirements;
  const targetWords = req.wordCountMin ?? req.wordCountMax;
  const wordCountLine = (() => {
    if (req.wordCountMin && req.wordCountMax) {
      const mid = Math.round((req.wordCountMin + req.wordCountMax) / 2);
      return `Target the MIDDLE of the rubric range (${req.wordCountMin}–${req.wordCountMax}); aim for roughly ${mid} words. Under-shooting by 30% is the most common failure on this prompt — DO NOT stop early. If you find yourself near a natural conclusion before the word target, expand: deepen the analysis, add a counter-argument paragraph, unpack a claim with a specific example.`;
    }
    if (targetWords) {
      return `Target ~${targetWords} words. Going noticeably under is a common failure — keep writing until you hit it.`;
    }
    return `No explicit word target. Write to the natural length of the form.`;
  })();
  const formatGuide = (() => {
    const fmt = req.deliverableFormat;
    if (!fmt) return '';
    const lower = fmt.toLowerCase();
    if (lower === 'literature review' || lower === 'systematic review') {
      return `\n\nDELIVERABLE FORMAT — ${fmt}:
- Structural template: brief Introduction → one section per source (Article 1, Article 2, …) each with sub-headings Introduction / Summary / Analysis / Conclusion → Final Synthesis comparing the sources → References.
- Each per-source Analysis sub-section is the heaviest: it is where you EVALUATE the source against the assignment's criteria (audience fit, methodological strength, alignment with established frameworks, practical utility, limitations) using SPECIFIC details from that source — not generic comments about literature.
- Cite each per-source section's claims back to that source's anchors. Cross-cite to other sources only in the Final Synthesis.`;
    }
    if (lower === 'lab report') {
      return `\n\nDELIVERABLE FORMAT — lab report:
- Structural template: Title → Abstract (optional) → Introduction → Method → Results → Discussion → Conclusion → References.
- Method and Results are descriptive, low-citation; Introduction and Discussion carry the citations.`;
    }
    if (lower === 'policy memo' || lower === 'policy brief') {
      return `\n\nDELIVERABLE FORMAT — ${fmt}:
- Structural template: Title → BLUF (Bottom Line Up Front, 1–3 sentences) → Background → Analysis → Recommendations → References.
- Lead with the recommendation; everything else justifies it.`;
    }
    if (lower === 'annotated bibliography') {
      return `\n\nDELIVERABLE FORMAT — annotated bibliography:
- One entry per source: full citation followed by a 100–200 word annotation (summary + evaluation + relevance to the project).
- No body essay — the annotations ARE the deliverable.`;
    }
    return `\n\nDELIVERABLE FORMAT — ${fmt}: follow the standard structural conventions of this format.`;
  })();
  const frameworkGuide = req.framework
    ? `\n\nFRAMEWORK / METHOD TO APPLY — ${req.framework}:
- The user explicitly asked for this. APPLY it as the analytical lens that organises the draft. Don't write ABOUT the framework — USE it.
- Concretely: each section's analysis should USE the framework's categories / criteria / steps to structure what you say about the evidence. If the framework has named domains/criteria/components, name them as you apply them.
- ${guideAnchors.length > 0 ? 'Method instructions for this framework are in the GUIDANCE ANCHORS below — internalise them; never cite them.' : 'You may apply the framework from your own knowledge of it. Stay faithful to its standard form.'}`
    : '';
  const guidanceNote =
    guideAnchors.length > 0
      ? `\n\nThis session has ${guideAnchors.length} GUIDANCE-role anchor${guideAnchors.length === 1 ? '' : 's'}. They are method/framework material — read them, internalise the instructions, and write accordingly. NEVER cite them inline. NEVER include them in the References list. They are HOW you write, not WHAT you cite.`
      : '';

  return `[HARD RULES — non-negotiable. Violating any of these is a shipping failure.]

1. **CITE YOUR SOURCES.** The reference-role anchor log below is the session's evidence base. Every factual claim, specific number, named figure, technical definition, contested position, or historical fact in your draft MUST carry an inline Harvard citation drawn from a REFERENCE-role anchor. A draft with ZERO citations is a hard failure. Guidance-role anchors are NEVER cited.

2. **FORMAT — in-text citation:** \`([Author, Year](slug.md#anchor-id))\`. The whole parenthesised chunk is a single markdown link whose href carries the \`#anchor-id\`. Reader sees "(Author, Year)"; hover reveals the verbatim anchor passage. The exact "(Author, Year)" string to type is shown next to each reference anchor below — use it verbatim. NEVER drop the \`#anchor-id\` fragment.

3. **CITATION DENSITY floor.** Roughly 1 citation per 150–200 words of body prose. For a 2,000-word essay that means ~10–15 inline citations minimum. Fewer means you're gliding past load-bearing claims without grounding them.

4. **ZERO em dashes (—) in the final draft.** Use a period, comma, parentheses, or colon instead. Em dashes are the strongest AI-prose tell. Don't substitute en dashes (–) either.

5. **HONOUR THE WORD-COUNT RANGE.** Going over or under by more than 10% is a failure. ${wordCountLine}

6. **STRUCTURE WITH HEADINGS.** Every draft opens with a \`# Title\` H1 and breaks the body into \`## Section\` H2s. When the deliverable mode below specifies an H2 list, USE IT VERBATIM. Otherwise pick H2s that argue rather than label. A wall of unbroken prose with no H2s is a shipping failure.

7. **APPLY USER-STATED CONSTRAINTS.** If the rubric names a framework or deliverable format, you MUST apply it. Writing about it instead of using it is a hard failure.

8. **DEPTH OVER BREADTH.** Each cited claim gets UNPACKED with the source's specifics — actual numbers, mechanisms, named techniques, concrete examples — not collapsed into a one-sentence summary. See the depth examples below.

You are Myst, writing the first full draft of "${docLabel}" from a completed Deep Plan session. You are an essayist with an evidence bundle. The VISION is the intellectual spine. The ANCHOR LOG is the evidence pile. Your job: turn the vision into finished analytical prose, grounded by the anchors, in the writer's voice.

User's task: "${session.task}"${constraintsLine}

RUBRIC (HARD constraints — the draft is judged against these):
${requirementsBlock(session.requirements)}${drafterModeBlock(session.mode)}${formatGuide}${frameworkGuide}${guidanceNote}

VISION — the intellectual spine. Follow its thesis, POV, and section intents. The vision itself has no citations; it tells you WHAT to write.

${visionBlock(session.vision)}

${anchorCountLine}

Each REFERENCE anchor below shows the citation tag you should type — \`(Author, Year)\` or \`(SourceName)\` — and the slug fragment that goes in the markdown link href. Paraphrase the anchor text naturally; do NOT copy verbatim unless the exact wording is genuinely load-bearing.

${anchorLogBlock(anchors)}

HOW TO WRITE THE DRAFT:

1. **Vision is your spine.** Its section intents are your structure. Its POV is the voice. Its novel insights are what the piece ARGUES.
2. **Reference anchors are evidence you USE.** For every claim, scan the reference anchors for one that grounds it. The citation tag tells you literally what to type.
3. **Guidance anchors shape HOW you write.** They are framework / method / style instructions. Internalise them; never cite them.
4. **Aim to use most of the reference log.** If the log has 20 reference anchors, expect 15+ to appear at least once. Unused anchors are evidence you gathered and ignored.
5. **Lead paragraphs with YOUR claim.** A paragraph's topic sentence is your analytical move; the evidence comes in to support it.
6. **Unpack each cited claim with SPECIFICS.** When an anchor names a method, name the method. When it gives a number, give the number. When it specifies a mechanism, describe the mechanism. Generic restatement isn't analysis.

Depth — what shallow vs deep looks like:
- Shallow: "The article highlights advances in monitoring technology." (Reader learns nothing specific.)
- Deep: "The article divides assessment methods into two categories: non-invasive approaches such as behavioural observation and underwater imaging, and invasive physiological markers like cortisol assays — flagging that chronic stress depresses growth, immunity, and survival." (Reader learns WHAT, HOW, and SO WHAT.)
- Shallow: "Research suggests welfare programs are increasingly important."
- Deep: "Collins (2023) traces the absence of a national assurance scheme in Australia against the spread of comparable frameworks in the EU, where rising welfare standards now function as a market-access requirement for export dairy."
The deep version is two-to-three times longer per claim — and that's the point. Draft length comes from depth per claim, NOT from extra claims.

Citation mechanics (strict):
- Use the citation tag printed next to each reference anchor — that's the visible text. Don't invent a different one.
- Examples:
  - Inline: \`...the liberal paradox ([Sen, 1970](sen-1970.md#liberal-paradox)) shows that minimal liberalism and Pareto are incompatible.\`
  - Institution: \`...as the Federal Reserve documents ([Richmond Fed, 2011](richmond-feldstein.md#defense)).\`
- Two sources on a sentence → two adjacent citations: \`([Smith, 2022](smith.md#a)) ([Jones, 2019](jones.md#b))\`.
- Same source, adjacent sentences → cite ONCE at the natural anchor point.
- Never wrap citations in backticks; never emit numeric footnote markers; never write "Smith et al. (2022)" as inline prose (the parenthesised markdown link IS the citation).

Blockquote discipline: default zero. One or two max if a primary-source quotation carries unique rhetorical weight.

Voice:
- Transitions should DO WORK — reframe, pivot, raise stakes. "The historical context matters" is dead weight; name what it matters FOR.
- Avoid stock LLM tells: "These are not minor caveats", "It's worth noting", "The conclusion is straightforward", "This is significant because".

Counter-argument + conclusion:
- Address the strongest objection to the thesis before rebutting or conceding. Name it specifically.
- The conclusion engages every major thread the body developed, named specifically. No generic "supplementing with frameworks that engage..." lists.

References section (required, end of draft) — HARVARD STYLE:
- \`## References\` heading (sentence case).
- ONE bullet per UNIQUE slug you actually CITED INLINE in the body. NOT one per anchor (multiple anchors share a slug). NOT one per source in the wiki (don't list uncited sources). NOT one per guidance source (NEVER list guidance sources).
- Harvard format per entry:
  \`- Author (Year) *Title*. Publisher or outlet. doi:10.xxxx/xxxx [[web](https://…)] [[source](slug.md)]\`
  - **Author**: surname(s) with initial(s) when known ("Sen, A.", "Smith, J. and Jones, K."). Institutional: full name. Use the author shown in the citation tag.
  - **(Year)**: integer year when shown in the citation tag. \`(n.d.)\` only as a last resort.
  - **Title** in italics, original capitalisation. The reference anchors carry titles when extracted at ingest.
  - **Publisher / outlet** when identifiable (journal name, news outlet, institution).
  - **\`doi:...\`** when present — bare DOI prefix, no URL.
  - **\`[[web](URL)]\`** — clickable link to the original. Use the source URL shown in anchor entries. Omit if you don't have one.
  - **\`[[source](slug.md)]\`** — always the final element: Myst-internal link.
- Examples:
  - \`- Sen, A. (1970) *The Impossibility of a Paretian Liberal*. Journal of Political Economy. [[web](https://www.jstor.org/stable/1829989)] [[source](sen-1970.md)]\`
  - \`- Barreto, M. O., Planellas, S. R., Yang, Y., Phillips, C., & Descovich, K. (2021) *Emerging indicators of fish welfare in aquaculture*. Reviews in Aquaculture. doi:10.1111/raq.12601 [[source](barreto-2021.md)]\`
  - \`- Stanford Encyclopedia of Philosophy (2018) *Pareto Efficiency*. [[web](https://plato.stanford.edu/entries/pareto/)] [[source](pareto-efficiency.md)]\`
- Alphabetise by author surname (or institution name when author-less). Do NOT duplicate. Do NOT include any guidance-role source.

Structure + headings (mandatory):
- **Open with a \`# Title\` H1.** Pick a title that names the piece's actual angle, not a restatement of the task.
- **Use H2 section headings (\`## Section title\`) to break the body.** Derive the H2s from the vision's section-arc + the deliverable format above. The deliverable-format guide names structural sections when relevant — use those H2 names; otherwise pick H2s that argue rather than label.
- **References is its own \`## References\` H2 at the end.** Always the final section.

Form + output rules:
- Hit the rubric — length, form, audience, deliverable format, framework.
- No preamble, no "Here is your draft:", no meta-commentary. Start with the H1 title line.
- Use proper markdown: \`#\` title, \`## Section\` H2s, \`**bold**\`, \`*italic*\`, blank lines between paragraphs.

Output: the complete markdown draft, nothing else.

---

Prose style / commands (internalise before writing a single word). The HARD RULES at the top and the citation mechanics above dominate any tension with the prose guide below.

${DEEP_PLAN_COMMANDS}`;
}
