import type {
  ChairAnswerMap,
  ChairQuestion,
  DeepPlanPhase,
  DeepPlanRubric,
  DeepPlanSession,
  PanelOutput,
  PanelRole,
  SourceMeta,
} from '@shared/types';
import { PROSE_STYLE } from '../../writing';

/**
 * Prompt templates for the new Deep Plan pipeline.
 *
 *   - `panelistPrompt` — one system prompt per cheap-model panel call.
 *     Parameterised by `PanelRole` so each voice has a narrow lens.
 *   - `chairPrompt` — one strong-model call per round. Synthesises the
 *     panel's structured findings into `{summary, questions, phaseAdvance,
 *     rubricPatch}` for the user-facing Question Card.
 *   - `oneShotPrompt` / `preDraftLookupPrompt` — unchanged drafter flow
 *     at the handoff from `reviewing → done`.
 *   - `deepSearchPlannerPrompt` — kept for the independent Deep Search
 *     feature.
 */

function rubricIsEmpty(rubric: DeepPlanRubric): boolean {
  return (
    !rubric.title &&
    !rubric.form &&
    !rubric.audience &&
    !rubric.lengthTarget &&
    !rubric.thesis &&
    rubric.mustCover.length === 0 &&
    rubric.mustAvoid.length === 0 &&
    !rubric.notes.trim()
  );
}

function rubricBlock(rubric: DeepPlanRubric): string {
  const lines = [
    `- Title: ${rubric.title ?? '(unset)'}`,
    `- Form: ${rubric.form ?? '(unset)'}`,
    `- Audience: ${rubric.audience ?? '(unset)'}`,
    `- Length target: ${rubric.lengthTarget ?? '(unset)'}`,
    `- Thesis / angle: ${rubric.thesis ?? '(unset)'}`,
    `- Must-cover: ${rubric.mustCover.length ? rubric.mustCover.join('; ') : '(none yet)'}`,
    `- Must-avoid: ${rubric.mustAvoid.length ? rubric.mustAvoid.join('; ') : '(none yet)'}`,
    `- Notes: ${rubric.notes || '(none yet)'}`,
  ];
  return lines.join('\n');
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

/**
 * Rich source block for the one-shot draft pass. Each source gets its full
 * wiki-style detailed summary (the `sources/<slug>.md` body produced at
 * ingest) — 2-4 paragraphs that capture the arguments, data, and
 * conclusions of the source.
 */
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

export const DEEP_REFERENCE_RIDER = `[Deep reference] Each source above may list anchor ids (format \`slug#anchor-id\`) beneath it. To pull the EXACT verbatim passage for an anchor, emit a fenced \`source_lookup\` block. The system will resolve it deterministically and inject the verbatim text into the conversation before your next turn. Never paraphrase quotes from memory — use the lookup.

Format:
\`\`\`source_lookup
{"slug": "smith-2022", "anchor": "law-1-2"}
\`\`\`
Multiple lookups in one response are fine. Use them freely when precision matters.`;

/* ────────────────────────── Panel (cheap-model) ────────────────────────── */

/**
 * Role personas. Each is a narrow adversarial lens — one paragraph tops.
 * Keep them aggressive and specific; a generic persona produces generic
 * findings.
 */
const ROLE_PERSONAS: Record<PanelRole, string> = {
  explorer: `EXPLORER. Expand the problem space. Look for adjacent angles, analogies, framings, or sub-topics the writer has not considered. When the task is vague, propose concrete directions it could take. You are the voice that asks "have you thought about X?" Your findings should open doors, not close them.`,

  scoper: `SCOPER. Push the writer toward concreteness. Flag anything vague — a fuzzy thesis, an unnamed audience, an abstract claim that needs a specific example, a scope too broad for the length. Your findings should each name one specific abstraction and demand a specific answer.`,

  stakes: `STAKES-RAISER. Force "so what?" and "for whom?". If the stakes are unclear, the piece has no reason to exist. Ask: why does this matter? To whom? What changes if the reader agrees? A finding from you always names a stake that's missing or under-articulated.`,

  architect: `ARGUMENT ARCHITECT. Propose or stress-test the thesis chain — the sub-claims that must hold for the main claim to hold. Flag where the chain breaks, where a sub-claim is load-bearing but unsupported, where a better framing exists. Your suggestedAction for each finding should name the specific chain surgery required.`,

  evidence: `EVIDENCE SCOUT. Identify the specific claims the plan makes (or will make) that need external evidence. Your findings are pointers to gaps in the wiki; your \`needsResearch\` queries are how you pay them off. Be prolific on \`needsResearch\` — this is your main output channel. Prefer primary sources (papers, official docs, firsthand accounts) over commentary.`,

  steelman: `STEELMAN. Construct the strongest opposing position to the plan's emerging thesis. State it in one or two sentences, charitably and accurately. Then check whether the plan has a response. If not, that is a high-severity finding — the plan will fall to this objection unless it addresses it.`,

  skeptic: `SKEPTIC. Find claims that would collapse under pressure — unstated assumptions, weak evidence, logical gaps, overreach. Be harsh. Every finding names a specific claim and the specific failure mode. Do not raise stylistic issues — that is the Editor's job.`,

  adversary: `ADVERSARY. Read the plan as a hostile reviewer would. Where is the argument most vulnerable? What will a reader attack first? What question will stop them dead on first read? Findings here should be framed as "a hostile reader will say: …".`,

  editor: `EDITOR. Look for redundancy, broken through-lines, pacing problems, and coherence gaps in the emerging outline. Findings should name specific sections or beats and why they don't carry their weight. Suggest cuts and reorderings. Do not critique argument quality — that is the Skeptic's job.`,

  audience: `AUDIENCE. Inhabit the stated reader. What will land? What will confuse? What do they already know (so don't belabour it)? What do they not know (so explain it)? Findings should name specific passages or claims and predict the reader's reaction.`,

  finaliser: `FINALISER. Propose the concrete section-by-section beat sheet the drafter will use. Each beat is ONE finding with severity "low" and a suggestedAction of the form:
"BEAT: <short title> — <one-line intent>. Anchors: <slug1>[#anchor-id], <slug2>.".
Emit beats in reading order. Include 4–8 beats. The drafter consumes these verbatim — be precise and opinionated.`,
};

/**
 * Compact context block passed to every panelist. Short prior-rounds
 * history prevents the panel from repeating the same findings every
 * round. We don't pass the full message log — panelists are stateless
 * adversarial voices, not conversational partners.
 */
interface PanelContext {
  session: DeepPlanSession;
  sources: SourceMeta[];
  lastChairSummary: string | null;
  lastAnswers: ChairAnswerMap | null;
  priorFindingsDigest: string;
}

function answersBlock(answers: ChairAnswerMap | null, questions: ChairQuestion[]): string {
  if (!answers || Object.keys(answers).length === 0) return '(no answers yet)';
  const byId = new Map(questions.map((q) => [q.id, q]));
  const lines: string[] = [];
  for (const [id, ans] of Object.entries(answers)) {
    const q = byId.get(id);
    const prompt = q?.prompt ?? `(question ${id})`;
    if (ans === null) {
      lines.push(`- Q: ${prompt}\n  A: (skipped)`);
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
    // string — could be a choice id for 'choice' or a free-text for 'open'.
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
    // The Chair's last questions, needed to resolve choice-id answers.
    const lastChairMsg = [...session.messages].reverse().find((m) => m.kind === 'chair-turn');
    return lastChairMsg?.chair?.questions ?? [];
  })();
  return [
    `User's task: "${session.task}"`,
    `Current phase: ${session.phase}`,
    '',
    'Rubric so far:',
    rubricBlock(session.rubric),
    '',
    'Wiki — sources already ingested (one-line summaries, anchors if any):',
    sourcesBlock(sources),
    '',
    lastChairSummary
      ? `Last Chair summary to the user:\n"${lastChairSummary}"`
      : '(this is the first panel round for this phase)',
    '',
    `Last user answers to the Chair:\n${answersBlock(lastAnswers, lastQuestions)}`,
    '',
    priorFindingsDigest
      ? `Prior-round findings digest (do NOT repeat these — raise NEW points):\n${priorFindingsDigest}`
      : '(no prior rounds)',
  ].join('\n');
}

/**
 * System prompt for a single panelist. The `role` parameter selects the
 * persona. Every panelist returns the same JSON shape, which the panel
 * runner parses into `PanelOutput`.
 */
export function panelistPrompt(role: PanelRole, ctx: PanelContext): string {
  const persona = ROLE_PERSONAS[role];
  return `You are ONE voice on an adversarial panel helping a writer build a plan. You do not talk to the writer — you report structured findings to the Chair, who synthesises the whole panel into one message for the writer.

Your role:
${persona}

Context:
${panelContextBlock(ctx)}

Output ONLY a JSON object of this exact shape — no prose, no markdown fences, no commentary:

{
  "findings": [
    {
      "severity": "high" | "mid" | "low",
      "claim": "one sentence naming what you observed",
      "rationale": "one sentence saying why it matters",
      "suggestedAction": "one sentence saying what the writer should do about it"
    }
  ],
  "needsResearch": [
    {"query": "librarian-style search query, 3–5 plain lowercase terms, no site: filters, no quoted phrase stacks", "rationale": "one sentence on why this query fills a specific gap"}
  ]
}

Rules:
- At most 4 findings. Quality over quantity — only raise what genuinely matters for this phase.
- At most 3 research queries. Only include \`needsResearch\` when you genuinely need external evidence the wiki doesn't cover.
- Do NOT duplicate findings already raised in prior rounds (see digest above).
- Be specific. Vague findings like "thesis could be stronger" are useless; findings like "the plan asserts X but no source backs it" are useful.
- If you genuinely have nothing to add this round, output {"findings": [], "needsResearch": []}. This is the right answer more often than you think.`;
}

/* ────────────────────────── Chair (strong-model) ────────────────────────── */

const PHASE_INTENT: Record<DeepPlanPhase, string> = {
  ideation: `IDEATION — shape a vague task into a concrete idea. By end of phase the writer should have a clear thesis candidate, an identified audience, and a rough angle. Research is light here; depth comes next.`,
  planning: `PLANNING — identify the key points, arguments, and evidence the piece will use. Heavy research dispatch. By end of phase the writer should have a validated thesis chain with sources attached to each sub-claim and a response to the strongest counter-argument.`,
  reviewing: `REVIEWING — stress-test the plan and produce the concrete section beat sheet the drafter will use. Research only for filling specific holes. End of phase = handoff to draft.`,
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
}

export function chairPrompt(args: ChairPromptArgs): string {
  const { session, panelOutputs, newlyIngestedSourceSlugs, roundNumber } = args;
  const phase = session.phase;
  const rubricIsBlank = rubricIsEmpty(session.rubric);
  const priorSummaries = priorChairDigest(session);
  const researchNote =
    newlyIngestedSourceSlugs.length > 0
      ? `\nResearch dispatched this round landed ${newlyIngestedSourceSlugs.length} new source(s) in the wiki: ${newlyIngestedSourceSlugs.join(', ')}. Factor these into your synthesis.`
      : '';

  return `You are the CHAIR of an adversarial panel helping a writer build a plan. The panel has just produced ${panelOutputs.length} sets of findings. Your job: synthesise them into one short message for the writer, plus a small set of targeted questions they can answer one-at-a-time in a dedicated card (not in chat).

Phase intent:
${PHASE_INTENT[phase]}

Current round in this phase: ${roundNumber}
User's task: "${session.task}"

Rubric so far${rubricIsBlank ? ' (empty — use rubricPatch to fill key fields as the user commits to them)' : ''}:
${rubricBlock(session.rubric)}

Panel findings this round:
${findingsBlock(panelOutputs)}${researchNote}

${priorSummaries ? `Prior-round Chair summaries (do NOT repeat these — move the plan FORWARD):\n${priorSummaries}\n\n` : ''}Output ONLY a JSON object of this exact shape — no prose, no markdown fences:

{
  "summary": "≤ 2 sentences, ≤ 60 words. Digest what the panel chewed on + what you want from the user next.",
  "questions": [
    {
      "id": "q1",
      "type": "choice" | "multi" | "open" | "confirm",
      "prompt": "the question as a single clear sentence",
      "choices": [{"id": "short-id", "label": "the option as the user sees it"}],
      "rationale": "optional one-line why this matters"
    }
  ],
  "phaseAdvance": true | false,
  "rubricPatch": {"thesis": "...", "mustCover": ["..."], "audience": "..."}
}

Rules:
- At most 5 questions. Prefer \`choice\` (labelled options with ids) > \`confirm\` (yes/no, no choices array needed — treat id "yes"/"no") > \`multi\` > \`open\`. Open questions are heavy; use them sparingly.
- Every \`choice\` and \`multi\` question MUST include a \`choices\` array of 2–5 options. Option \`id\` values are short kebab-case labels; \`label\` is what the user sees.
- \`phaseAdvance: true\` ONLY when the panel surfaced no substantive new tensions AND the rubric has what it needs for this phase. Err toward \`false\`; the loop will advance when the user hits Continue anyway.
- \`rubricPatch\` fields are optional. Include a field ONLY when the user has implicitly committed to a value via their answers or the panel is converging on one. Never invent.
- If the panel requested research that was genuinely useful, acknowledge the new sources in the summary ("panel pulled in three papers on X — one contradicts your framing").
- Summary voice: calm, opinionated, colleague-like. Not a lecture. Not a sales pitch. Terse.
- Remember: questions go into a dedicated card, not into chat. Phrase them so they work as standalone prompts without the summary for context.`;
}

/* ─────────────────── Deep Search planner (unchanged) ─────────────────── */

const QUERY_STYLE = `Write queries like a research librarian, not a power user:
- 3–5 plain keywords, lowercase, no punctuation.
- Avoid quoted phrases unless the exact wording is a term of art (e.g. "chain of thought"). Multiple quoted phrases AND'd together almost always return zero results.
- No \`site:\` filters unless you've confirmed the domain has what you want. Let the search engine rank authoritative sources (arxiv, official docs, .edu) on its own.
- No dates unless the query is specifically time-sensitive.
- Each query should be a single conceptual angle — if you catch yourself AND-ing two ideas, split into two queries.

Quality bar: 3–4 well-shaped queries beat 5 over-specified ones. Broad beats narrow.`;

export function deepSearchPlannerPrompt(
  task: string,
  sources: SourceMeta[],
  priorQueries: string[],
  hints: string[],
  rubric: DeepPlanRubric | null = null,
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
  const rubricSection =
    rubric && !rubricIsEmpty(rubric)
      ? `\n\nPlan rubric (the user's writing task — prefer queries that feed the thesis and must-covers; avoid must-avoid areas):\n${rubricBlock(rubric)}`
      : '';

  return `You are the research query generator for Myst's Deep Search — a research-only mode that finds and ingests sources into the user's wiki without touching what they're writing. Your ONLY job is to emit the next batch of web searches — no prose, no chat.

Research task: "${task}"${rubricSection}

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
 * Pre-draft lookup pass. The model reads the rubric, synthesis, and wiki
 * summaries, and emits `source_lookup` fences for any anchors / source
 * pages / raw files it wants verbatim before committing to the draft.
 */
export function preDraftLookupPrompt(
  session: DeepPlanSession,
  sources: SourceMeta[],
  detailedSummaries: Map<string, string>,
  plannerSynthesis: string,
  researchSummary: string,
  docLabel: string,
): string {
  const synthesisBlock = plannerSynthesis.trim()
    ? `Planning conversation — what the user and planner agreed on:\n${plannerSynthesis.trim()}\n\n`
    : '';
  const researchBlock = researchSummary.trim()
    ? `Research phase summary:\n${researchSummary.trim()}\n\n`
    : '';

  return `You are Myst's pre-draft researcher. The next step is a one-shot draft of "${docLabel}" — but BEFORE that draft runs, you get one pass to pull any verbatim source passages you think will make the draft sharper. The draft model will see everything you pull, pre-fetched, with no further chance to look anything up.

Your ONLY job right now is to decide which anchors (and optionally which full source pages) to pull. You are NOT writing the draft in this turn.

User's task: "${session.task}"

Rubric (what the draft will aim at):
${rubricBlock(session.rubric)}

${synthesisBlock}${researchBlock}Wiki — sources with full detailed summaries and anchor labels:

${richSourcesBlock(sources, detailedSummaries)}

${DEEP_REFERENCE_RIDER}

Think about the draft you'd write from the summaries above, then ask yourself:
- Which specific claims, numbers, definitions, or arguments will the draft lean on hardest? Pull those anchors.
- Are there quotes that would carry a point better verbatim than paraphrased? Pull those.
- Are there sources whose one-paragraph summary feels thin for what the draft needs? Pull the full source page.
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

[Prose-style guide, applies to the draft that will run after this pass. You don't need to act on it now; it's here so your anchor selections match what the drafter will actually want to quote. The drafter will re-receive this guide.]

${PROSE_STYLE}`;
}

export function oneShotPrompt(
  session: DeepPlanSession,
  sources: SourceMeta[],
  detailedSummaries: Map<string, string>,
  plannerSynthesis: string,
  researchSummary: string,
  prefetchedPassages: string,
  docLabel: string,
): string {
  const synthesisBlock = plannerSynthesis.trim()
    ? `Planning conversation — what the user and planner agreed on:\n${plannerSynthesis.trim()}\n\n`
    : '';
  const researchBlock = researchSummary.trim()
    ? `Research phase summary:\n${researchSummary.trim()}\n\n`
    : '';
  const passagesBlock = prefetchedPassages.trim()
    ? `\nPre-fetched verbatim passages (pulled from the wiki off-disk for this draft — these are EXACT text, safe to quote directly):\n\n${prefetchedPassages.trim()}\n`
    : '';

  return `[HARD RULES. These override everything below, including the writing-style guide. Violating these is a bug, not a stylistic choice.]
- ZERO em dashes (—) in the final draft. Not one. Not "just stylistically". Not in quotes you're paraphrasing. If you feel the urge to use one, choose: a period (two sentences), a comma clause, parentheses, or a colon. Em dashes are the single strongest AI-prose tell and we do not ship them.
- Do not use en dashes (–) as a substitute. A regular hyphen (-) is fine inside compound modifiers; for sentence-level breaks use the alternatives above.
- EVERY non-trivial claim cites a source, inline, at the point the claim is made. A non-trivial claim is any factual statement, attribution, historical fact, date, statistic, definition, critique, named position, or interpretive argument. The only uncited sentences permitted are: (a) your own reasoning and framing, (b) logical connectives and transitions, (c) restatements of the user's own prompt. If you cannot cite it from the wiki below, omit it — never assert an un-sourced fact. A sparsely-cited draft is a failed draft.

You are Myst, writing the first full draft of "${docLabel}" from a completed Deep Plan session. You are an informed essayist, not a summariser of summaries. The wiki below is your knowledge base; treat it the way a good researcher would treat a pile of open books at their elbow: read it, wander it, quote from it, find the tensions between sources.

User's task: "${session.task}"

Rubric (your marching orders):
${rubricBlock(session.rubric)}

${synthesisBlock}${researchBlock}Wiki (sources with full detailed summaries and key anchor labels):

${richSourcesBlock(sources, detailedSummaries)}
${passagesBlock}
How to approach this draft (read carefully):

1. **Read the wiki first.** The detailed summaries above are not one-liners; they're multi-paragraph reads of each source. Hold them in mind before committing to a paragraph. Don't treat a source as a bullet point to cite once; treat it as something you've actually read.
2. **Follow ideas across sources.** A concept raised in one source is usually echoed, refined, or contested in another. Name those connections. A draft that just walks through one source at a time reads like a book report; don't do that.
3. **Find tensions.** If two sources pull in different directions on the same question, say so, frame the disagreement, and take a position (guided by the rubric's thesis).
4. **Quote sparingly but precisely.** When you do quote a source directly, prefer the pre-fetched verbatim passages above when present; those are exact text safe to reproduce. Otherwise only quote text that actually appears in the detailed summaries. Do not fabricate quotes. If you're not certain of the exact wording, paraphrase and cite.
5. **Counter-argument pass.** Briefly address the strongest objection to your thesis before rebutting or conceding.

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
- Sources that you did not actually cite in the body must NOT appear in References. The References list is a mirror of your inline citations, not a dump of the wiki.

Form + output rules:
- Hit the rubric's length target, form, and audience. Match the requested thesis/angle.
- No preamble, no "Here is your draft:", no meta-commentary. Start with the title or opening line and write the full piece straight through.
- Use proper markdown: \`#\` headings, \`**bold**\`, \`*italic*\`, blank lines between paragraphs.
- Do NOT make up sources, slugs, or quotes. If a source isn't in the wiki above, it doesn't exist for this draft.

Output: the complete markdown draft, nothing else.

---

Prose style (read and internalise before you write a single word). This is the bar the draft has to clear. Remember: the HARD RULES at the very top of this prompt, and the citation format above, dominate any tension with the prose guide below.

${PROSE_STYLE}`;
}

