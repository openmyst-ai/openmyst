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
  // Per-anchor lines are formatted as the exact citation form we want panel
  // + Chair to emit. Anchor labels are one-sentence paraphrases (phase 2) so
  // the reader can tell at a glance which anchor grounds which claim without
  // re-reading the source. Deliberately plain markdown — no backticks — so
  // when a model copies a line into plan.md it already looks right.
  return sources
    .map((s) => {
      const head = `- **${s.name}** (${s.slug}.md) — ${s.indexSummary}`;
      if (!s.anchors || s.anchors.length === 0) return head;
      const anchorLines = s.anchors
        .map((a) => `    - ([${s.name}](${s.slug}.md#${a.id})) [${a.type}] ${a.label}`)
        .join('\n');
      return `${head}\n${anchorLines}`;
    })
    .join('\n');
}

function searchBudgetBlock(session: DeepPlanSession): string {
  const remaining = Math.max(0, DEEP_PLAN_MAX_TOTAL_SEARCHES - session.searchesUsed);
  return `Search budget: ${session.searchesUsed}/${DEEP_PLAN_MAX_TOTAL_SEARCHES} used, ${remaining} remaining. Per-round panel cap: ${DEEP_PLAN_MAX_SEARCHES_PER_ROUND}. Searches are welcome — especially early, when the plan is sparse and one grounding source can sharpen a whole section. Don't burn every round on searches, but don't go silent either: when a specific plan claim would land harder with a primary source the wiki doesn't have yet, propose the query.

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

The anchor-first rule (this is the core of how the panel works now):
Plan.md is a DOCUMENT OF ANCHORED CLAIMS. Every non-trivial claim in it must point to a specific anchor in the wiki above — the exact sentence from a source that grounds the claim. If there's no anchor for a claim, the claim doesn't go in the plan. The panel's whole job, across every role, is to drive plan.md toward "every claim anchored". That means:
- Unanchored claims already in plan.md are bugs. Either find the anchor that supports them (from the wiki above) or propose a research query that would produce such an anchor.
- Findings that just restructure prose without touching evidence are low-value. Findings that surface a missing anchor, or propose swapping a weak anchor for a stronger one, are high-value.
- Searches exist to hunt anchors — not to "explore the space". A good \`needsResearch\` query is shaped to return a source containing a specific missing statistic, definition, or finding.

Your job this round:
1. Read the current plan.md and the wiki anchor list carefully. Anchor labels are one-sentence paraphrases — they tell you what each anchor actually says. Use them to judge whether the plan's claims are properly grounded.
2. Through your role's lens, identify the 2–3 most important anchor gaps or mis-groundings. Be specific: name the claim, the anchor missing, and the anchor that should replace or ground it.
3. For each finding, \`suggestedAction\` must be a concrete plan edit tied to an anchor. One of:
   - "Ground the claim in §X by citing ([Name](slug.md#anchor-id)) — the anchor states <paraphrase>."
   - "Swap the ([Old](old.md#x)) citation in §Y for ([New](new.md#y)) — stronger evidence because <reason>."
   - "Drop the unsupported sentence in §Z — no anchor in the wiki backs it and the claim isn't load-bearing."
   - "Add a §N grounded in ([Name](slug.md#anchor-id))."
4. When no anchor in the wiki supports a load-bearing claim, emit a \`needsResearch\` query. Frame it as "I need a [statistic|definition|claim|finding|quote] about X" — that tells the Chair what anchor type to hunt for. Reasoning alone produces a plan that sounds confident but isn't anchored.

Output ONLY a JSON object of this exact shape — no prose, no markdown fences, no commentary:

{
  "findings": [
    {
      "severity": "high" | "mid" | "low",
      "claim": "one sentence naming the anchor gap or mis-grounding in the plan",
      "rationale": "one sentence saying why it matters",
      "suggestedAction": "one sentence naming the concrete plan edit tied to an anchor (use Harvard markdown links)"
    }
  ],
  "needsResearch": [
    {"query": "3–5 plain lowercase terms, no site: filters", "rationale": "what anchor type (statistic/definition/claim/finding/quote) this query should yield, and which specific plan claim it unblocks"}
  ]
}

Rules:
- At most 3 findings. Quality over quantity. Findings that don't name an anchor or propose one are worthless.
${searchClause}
- When a \`suggestedAction\` references a source, write it as a Harvard-style markdown link: \`([Name](slug.md))\` or \`([Name](slug.md#anchor-id))\`. NEVER use backticked slug tokens (\`\`\`slug\`\`\`, \`\`\`slug#anchor\`\`\`) — the Chair copies your phrasing into plan.md body, and backticks render as code blocks there.
- Do NOT duplicate findings already raised in prior rounds (see digest above).
- If the plan is already cleanly anchored and no new tensions have surfaced, output {"findings": [], "needsResearch": []}. This is the right answer when the plan has converged.`;
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
  /**
   * Answers the user submitted to the PREVIOUS round's Chair questions.
   * Crucial for emitting `requirementsPatch` — without this the Chair has
   * no way to know what the user picked for word count / form / audience
   * and will re-ask the same questions every round.
   */
  lastAnswers: ChairAnswerMap | null;
}

export function chairPrompt(args: ChairPromptArgs): string {
  const { session, panelOutputs, newlyIngestedSourceSlugs, roundNumber, sources, lastAnswers } = args;
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

  return `You are the CHAIR of an adversarial panel helping a writer build a plan.md. The panel has just produced ${panelOutputs.length} sets of findings. Your job has two parts:

  1. REWRITE plan.md in full — absorb the panel's edits, keep what works, improve what doesn't. This is the artefact the final drafter will read.
  2. Speak to the user in a short summary, and ONLY when a genuine judgment call needs them, ask 1–${DEEP_PLAN_MAX_QUESTIONS_PER_ROUND} targeted questions.

Phase intent:
${PHASE_INTENT[phase]}

Current round in this phase: ${roundNumber}${advanceNudge}
User's task: "${session.task}"

Task requirements (hard constraints — the plan MUST honour these; echo the word-count range inside the plan body where relevant):
${requirementsBlock(session.requirements)}${requirementsGap}${lastAnswersSection}

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
- Structure: start with a title (H1), then a short thesis paragraph, then sections (H2) in reading order. Each section has a one-line intent and the claims it will develop.
- Honour the task requirements at the top of the plan — echo the word-count range and form in the thesis paragraph so the drafter can't miss them.
- Plan.md is the drafter's SOLE input. After Deep Plan completes, the drafter sees ONLY plan.md, the requirements, and the prose-style guide — no raw sources, no detailed summaries. Any evidence the draft needs has to be anchored inside plan.md by the end of the reviewing phase.

CONTINUITY — this is the single most important rule:
- Plan.md ACCUMULATES. It is not reset at phase transitions. Ideation's claims carry into planning; planning's carry into reviewing. A phase transition changes what you ADD this round — it never licenses dropping claims from prior rounds.
- **Every anchored claim from a prior round is COMMITTED.** Preserve it. You may reword the surrounding prose, move a claim between sections, or attach it to a different argument, but you MUST keep the \`([Name](slug.md#anchor-id))\` citation exactly as it was. A citation attached to a claim is a contract — the previous Chair or panel did the work to find that anchor, and you do not get to undo it.
- Before emitting your rewrite, count the \`([...](...))\` citations in the current plan.md shown above. Your new plan must contain AT LEAST that many citations. Fewer = you dropped committed work. More = you added new groundings. Same-or-more is the floor.
- **NEVER drop an existing claim just because it isn't anchored yet.** Unanchored claims are WORK TO DO, not content to delete. Carry them forward, mark them with \`[needs-anchor]\` (see UNANCHORED CLAIM MARKER below), and use the panel's research budget to produce anchors for them next round.
- Blockquotes beneath anchored claims (lines starting with \`>\`) are SYSTEM-INSERTED after your output by the materialiser. You do not need to preserve them in your rewrite — just emit the \`([Name](slug.md#anchor-id))\` citations and the system re-injects the quotes. Ignoring existing blockquotes while rewriting is fine; deleting the citations that produced them is not.
- Phase transitions change the FOCUS, never the content floor:
  - ideation → planning: keep every ideation claim; now add structure, sub-claims, and anchor-hunting for claims that still need grounding.
  - planning → reviewing: keep every planning claim; now stress-test the argument and finalise the beat sheet. This is when unanchored claims that have survived the panel's research attempts can be considered for dropping — but only with a panelist's explicit recommendation.

CITATION FORMAT — this is load-bearing. DIFFERENT rules at different phases:

- **ideation**: plan.md is still a rough skeleton. Most claims will be unanchored and that's FINE. Only emit a citation when you can literally match a claim to an anchor you can see in the wiki list above. Do NOT hallucinate anchor ids. Unanchored claims carry the UNANCHORED CLAIM MARKER (below) so the panel and user can see what still needs grounding.
- **planning**: the wiki should be filling up with real sources now. Prefer to anchor every factual claim, but keep unanchored claims that matter (marked) while the panel hunts for their grounding.
- **reviewing**: every non-trivial claim MUST be anchored OR explicitly dropped. This is the only phase where "drop the claim" is the right move for persistent unanchored claims — and even then, only after the panel has had a full round to find an anchor for it.

Anchor citation format (when you ARE citing):
- Harvard-style inline markdown link IN PARENTHESES, ending the sentence or clause: \`([Name](slug.md#anchor-id))\`. The \`#anchor-id\` MUST be a literal anchor id from the wiki list above — copy it verbatim, do not paraphrase or invent.
- **\`[Name]\` is the SOURCE'S DISPLAY NAME — nothing else.** Use the bold source name from the wiki block exactly (e.g., "Smith 2022", "Stanford Encyclopedia", "Pareto Optimality Definition Misleading"). NEVER put the anchor-id, anchor label, or a hyphen-separated slug fragment inside the \`[Name]\` brackets — readers see \`[Name]\` as the citation's visible label, and raw slugs like "pareto-efficiency-is-criticized-for-ignoring-equity-and-dist" leaking into prose is a shipping failure. If a source name is long, abbreviate conservatively — but keep it human.
- Before writing ANY \`([Name](slug.md#anchor-id))\`: scan the wiki block. If the exact \`#anchor-id\` is not listed under that source's bullets, DO NOT WRITE IT. A hallucinated anchor id silently fails the materialiser pass and hover lookup; it's worse than no citation at all.
- Slug-only citations are allowed: \`([Name](slug.md))\`. Use these when you want to credit a source but no specific anchor grounds the specific claim — better than a fake \`#anchor-id\`.
- If a sentence draws on two anchors, emit two adjacent citations: \`([Smith](smith.md#x)) ([Jones](jones.md#y))\`.
- Trivial connective prose ("This matters because…", "In the next section…") does NOT need a citation.
- Consolidate repetition: if the same source grounds three adjacent claims in a section, cite ONCE at the natural anchor point, not every sentence. Plan.md is a planning artefact, not a receipt; the drafter reads it and consolidates further, so you should already be consolidating here.
- The verbatim passage for each resolved \`([Name](slug.md#anchor-id))\` is AUTOMATICALLY inserted as a blockquote beneath the claim by the system after you respond. You do NOT write the blockquote yourself.

UNANCHORED CLAIM MARKER:
- For any non-trivial claim that doesn't yet have an anchor from the wiki above, end the sentence with the literal token \`[needs-anchor]\` (lowercase, in square brackets, no slug). Example: "Pareto efficiency depends on initial endowments [needs-anchor]."
- This is NOT a failure mode — early ideation plans should have LOTS of \`[needs-anchor]\` markers. They're the panel's to-do list: each one is a hint at a research query that will produce the anchor next round.
- Do NOT delete a \`[needs-anchor]\` claim just to shrink the plan. Only drop it when (a) a panelist explicitly says the claim isn't load-bearing, or (b) we're in the reviewing phase and the panel has tried and failed to anchor it.

Other forbidden forms:
- NEVER emit bare backticked slug tokens like \`\`\`slug\`\`\` or \`\`\`slug#anchor-id\`\`\`. Those render as code blocks and break the reader flow.
- NEVER emit footnote markers, numeric refs like "[1]", or "Smith et al. (2022)" prose — use the markdown-link form above.
- NEVER invent a slug or an anchor id. If the wiki doesn't have it, use \`[needs-anchor]\` instead.

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

requirementsPatch rule (critical — the system mutates session state from this):
- When the user's last answers (visible in the "Last Chair summary" / panel context above) answered a question about a hard requirement, POPULATE the corresponding fields in \`requirementsPatch\`. The system shallow-merges this into session.requirements so those fields become "specified" and you don't re-ask next round.
- \`wordCountMin\` / \`wordCountMax\`: integers in words. If the user picked "1500–2500", set both. If they picked a single number ("around 2000"), set both min and max equal. If they delegated, pick sensible defaults for the form (essay: 1500–2500; blog post: 800–1500; report: 2500–4000) and use those.
- \`form\`: short lowercase label ("exploratory essay", "blog post", "op-ed", "report").
- \`audience\`: short lowercase label ("general educated reader", "economists and policy professionals", etc.).
- \`styleNotes\`: free text — ONLY when the user stated specific style constraints. Otherwise \`null\`.
- Emit \`null\` (or omit) when the user's answers this round didn't touch hard requirements. Do NOT echo fields that are already specified unchanged — include only what's new or actually changed.
- If you ASKED about a requirement this round but the user hasn't answered yet, do NOT patch those fields. Leave the question in \`questions\` and wait for next round.

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
 * Phase-6 drafter prompt. Deliberately minimal: plan.md has already been
 * built by the Deep Plan panel + Chair, with every non-trivial claim
 * followed by a verbatim blockquote from the source it's anchored to (the
 * materialiser injects those after the Chair finishes each round). By the
 * time we reach this prompt, plan.md IS the evidence base — the drafter
 * does not need the wiki, the detailed summaries, or a pre-draft lookup
 * pass.
 *
 * Inputs the drafter gets: requirements, plan.md, prose-style guide.
 * That's it. The drafter's job is to turn anchored-claims-with-quotes into
 * finished prose while preserving every citation.
 */
export function oneShotPrompt(session: DeepPlanSession, docLabel: string): string {
  return `[HARD RULES. These override everything below, including the writing-style guide. Violating these is a bug, not a stylistic choice.]
- ZERO em dashes (—) in the final draft. Not one. Not "just stylistically". Not in quotes you're paraphrasing. If you feel the urge to use one, choose: a period (two sentences), a comma clause, parentheses, or a colon. Em dashes are the single strongest AI-prose tell and we do not ship them.
- Do not use en dashes (–) as a substitute. A regular hyphen (-) is fine inside compound modifiers; for sentence-level breaks use the alternatives above.
- Cite only SOURCE-DERIVED claims that carry real analytical weight. Plan.md is working material, not a receipt — you are expected to CONSOLIDATE its citations, not reproduce them 1-to-1. A finished essay of 2,000 words carries roughly 10–20 citations, not 40+. Over-citation reads like an unfinished research brief and actively disrupts reading.
- HONOUR THE WORD-COUNT RANGE in the requirements below. This is a contract. Going over or under by more than 10% is a failure — use plan.md's section breakdown to budget your words before you start writing.

You are Myst, writing the first full draft of "${docLabel}" from a completed Deep Plan session. You are an essayist with an evidence bundle, not a citation manager. Plan.md below is the evidence the panel gathered; your job is to turn it into finished analytical prose — led by your own argumentative voice, supported (not buried) by citations where they earn their weight.

User's task: "${session.task}"

Task requirements (HARD constraints — the draft is judged against these):
${requirementsBlock(session.requirements)}

plan.md — the complete output of the Deep Plan session. This is your ENTIRE evidence base. Every non-trivial claim already has a Harvard-style citation \`([Name](slug.md#anchor-id))\` followed by a blockquote with the verbatim source passage. You do NOT need any other sources; you should not reference anything that isn't in this plan.

${planBlock(session.plan)}

VOICE AND INTEGRATION (read this before you start drafting):

Plan.md has been built by a panel of cheap adversarial models and a strong Chair. Every section is anchored, every factual claim carries a source. That's done. What's NOT done is the essay itself — and the fastest way to ship a mediocre draft is to march sentence-by-sentence through the plan, each sentence ending in a citation, each paragraph a chain of cited claims with no argumentative through-line.

Write like an essayist, not a transcriber:
- Lead each paragraph with YOUR analytical claim or framing. Bring in the plan's evidence where it earns its weight. A paragraph's first sentence should almost never be a cited external claim; it should be your move.
- Paragraphs are arguments, not citation lists. If you find yourself writing three consecutive sentences that each end in a \`([Name](...))\`, stop and restructure. Compress the evidence, lift the argument.
- **Anchors are a starting point, not a script.** The blockquotes beneath each citation in plan.md are the verbatim source passages. Your job is to use them NATURALLY — paraphrase the idea in your own voice, compress three source sentences into one of yours, lift the load-bearing phrase while dropping the rest. DO NOT transcribe or lightly reword a blockquote sentence-by-sentence; that reads as mechanical and defeats the point of a human-quality draft. Think of the blockquote as "here's what the source says — now say what MATTERS about it in your own words".
- Integrate quotes INTO sentences when you genuinely quote. Prefer "Pareto himself insisted that 'political economy does not have to take morality into account' ([Pareto](pareto.md#x))" over a standalone blockquote. Reserve blockquotes for passages where the full verbatim wording is genuinely load-bearing — at most one or two in a 2,000-word essay.
- The blockquotes shown beneath citations in plan.md are WORKING MATERIAL. They are there so you have the source's exact wording at hand while drafting. They MUST NOT appear as literal blockquotes in the final draft (except for those rare one or two cases). Integrate, paraphrase, or quote inline.

PRESERVE ANCHOR IDs — this is load-bearing for the product's value prop:
- Every citation in the final draft keeps its full \`#anchor-id\` fragment exactly as plan.md has it: \`([Name](slug.md#anchor-id))\`, NOT \`([Name](slug.md))\`. The \`#anchor-id\` is what powers the hover feature — readers can hover any citation and see the verbatim source passage you paraphrased from. This is how the system lets users cross-check your work; dropping the fragment breaks that contract.
- If plan.md's citation has a \`#anchor-id\`, your draft's citation MUST have the same \`#anchor-id\`. Carrying this through is non-negotiable.
- The \`#anchor-id\` is invisible to readers in normal rendered markdown — it only appears on hover. So preserving it costs nothing visually and gives the reader full provenance on demand.

Citation consolidation (this is the single biggest fix from prior drafts):
- When consecutive sentences draw on the SAME source, cite ONCE — at the natural anchor point for that claim cluster (end of the topic sentence, or end of the paragraph's synthesis). Not at the end of every sentence.
- When a claim is textbook-level common knowledge in the domain ("neoclassical welfare theory rests on three efficiency conditions", "the First Welfare Theorem requires complete markets"), DO NOT cite. Uncited prose is earned when the claim is uncontested background.
- When a paragraph is mostly your analysis drawing on one source's evidence, a single citation at the paragraph's thesis point is sufficient.
- Load-bearing citations that DO earn their own inline link: specific numbers, named figures, contested positions, primary quotes, definitions of technical terms, specific historical facts.
- If plan.md cites the same source five times in one section, your section should cite it one or two times and trust the reader. This is a consolidation the drafter is expected to perform.

Blockquote discipline:
- Zero blockquotes in the final draft is a legitimate default. One or two blockquotes max if a primary-source quotation genuinely carries unique rhetorical weight.
- Never copy a materialised blockquote verbatim into your draft — paraphrase the claim and attach the citation, or pull the key phrase inline with quote marks.

Citation-name discipline (important cleanup):
- The \`[Name]\` inside a citation must read as a human-readable source label. If plan.md contains a citation whose \`[Name]\` looks like a raw slug or anchor id (hyphen-separated lowercase, no spaces — e.g., "pareto-efficiency-is-criticized-for-ignoring-equity-and-dist"), REWRITE the \`[Name]\` to a clean short label (a surname, a publication short-name, or a sensible descriptor) while preserving the \`(slug.md#anchor-id)\` link target exactly. Readers see the \`[Name]\`; raw slugs in prose are a shipping failure.

Transitions and prose voice:
- Transitions should DO WORK. "The historical context matters" is dead weight — name what it matters FOR. "The criticism cuts deeper" is filler — replace with the specific cut. Good transitions reframe, pivot, or raise stakes; bad transitions announce "moving on".
- Avoid the following stock interjections — they read as LLM signature: "These are not minor caveats", "The silence is not incidental", "It's worth noting", "The conclusion is straightforward", "This is significant because". If you catch yourself writing one, rewrite the sentence so the claim does the work the interjection was trying to do.

Counter-argument and conclusion balance:
- Address the strongest objection to your thesis before rebutting or conceding. Name it specifically.
- The conclusion must engage with each major thread the body developed. If the body covered five threads (framing, historical context, distributional critique, modern applications, a defense), the conclusion addresses all five — named specifically, not gestured at. A conclusion that ends with a generic list ("supplementing with frameworks that engage distributional weights and rights-based constraints...") without development is a failure. Close with a specific claim about what the concept does and does not do.

Citation format in the draft (strict):
- Harvard-style inline, always in parentheses: \`([Name](slug.md#anchor-id))\` or \`([Name](slug.md))\` when the plan cited the source without an anchor.
- If a sentence draws on two anchors, two adjacent citations: \`([Smith](smith.md#a)) ([Jones](jones.md#b))\`.
- Never wrap citations in backticks, never emit numeric footnote markers, never write "Smith et al. (2022)" style prose.

References section (required, end of draft):
- Add a \`## References\` heading (sentence case, no variations).
- List every unique slug actually cited in the body, once each. Format: \`- [Name](slug.md)\`. One line per source. Alphabetise by Name.
- Do NOT list sources you didn't cite. Do NOT duplicate.

Form + output rules:
- Hit the requirements above — length, form, audience. The word-count range is the single most important constraint.
- No preamble, no "Here is your draft:", no meta-commentary. Start with the title or opening line and write the full piece straight through.
- Use proper markdown: \`#\` headings, \`**bold**\`, \`*italic*\`, blank lines between paragraphs.

Output: the complete markdown draft, nothing else.

---

Prose style / commands (read and internalise before you write a single word). This is the bar the draft has to clear. Remember: the HARD RULES at the very top of this prompt, and the voice + citation rules above, dominate any tension with the prose guide below.

${DEEP_PLAN_COMMANDS}`;
}
