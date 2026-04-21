# OpenMyst philosophy

## The bet

Raw model capability is commoditising. Open-source is approaching frontier. In a world where model quality converges, the question is no longer *"which model do I use?"* — it's *"what do I feed it?"*

OpenMyst's bet: a well-scaffolded open-source model, given a deep personal wiki, structured planning, and live web research, can produce knowledge-work output that matches or exceeds a frontier model given a raw prompt ("write me an essay on X").

The surplus flows to whoever owns the **input layer** and the **writer's UX**, not the model.

## What "input layer" means here

Not "a longer prompt". Input layer = the full pipeline that sits between the user's intent and the token the model sees:

- The personal wiki (sources they curated, summarised, anchored, persisted).
- The planning conversation (rubric: thesis, audience, must-covers, angle).
- The live research phase (queries, ingestion, steering).
- The pre-draft lookup pass (verbatim passages pulled off disk).
- The citation/referencing discipline baked into the prompt.
- The author's own prior work as style and substance context.

A frontier model with a bad input layer writes confident slop. An open model with a great input layer writes grounded prose. That is the wager.

## What this rules out

- **"Better chatbot" positioning.** The chat surface is a means, not the product. If the moat is the pipeline, the interface has to be a drafting environment, not a Q&A box.
- **Over-scaffolding that cages the model.** Strong structure feeds the model; over-specified structure (e.g. the claim-menu experiment — see commit `ac7ed09`) strangles it. The rule: scaffold the *inputs* the model sees, then trust it to compose.
- **Generic research agents.** Deep Plan is not a research agent that happens to write — it is a *writer's* tool that happens to research. Everything flows from the writing task, not the other way around.

## What this rules in (the moat)

Things a frontier chatbot cannot easily replicate without rebuilding OpenMyst:

- **Persistent personal wiki** — the user's own knowledge graph, accumulated across sessions.
- **Traceable provenance** — every claim in a draft can be walked back to a source anchor, visibly.
- **Author-in-the-loop editing** — pending edits, comments, rubric edits, re-plans. The user is the writer, not the reviewer of a finished artefact.
- **Writer-specific UX** — inline citations as first-class data, not reformatted markdown; structure and prose as separable layers.

## Operating principles

1. **Input quality > model choice.** When performance lags, first ask what the model was given. Change the model last.
2. **Feed, don't cage.** Scaffolding should expand the model's context, not constrain its output surface.
3. **Everything a writer touches is the product.** The wiki, the plan, the citations, the edits. The generated prose is one output among several artefacts.
4. **Provenance survives transformation.** If the user edits a sentence, its source link should follow the claim, not the original text.
5. **Open-source-first by default.** If a feature needs frontier-only capability, question the feature before paying the premium.
