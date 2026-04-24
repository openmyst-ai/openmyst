# Panel Roles, Reference

This is the canonical map of who's on the Deep Plan panel at each phase
and what job each role is actually given, taken verbatim from the system
prompts in [src/main/features/deepPlan/prompts.ts](../src/main/features/deepPlan/prompts.ts).

The panel is deliberately **phase-specific**. Ideation panels open doors;
planning panels structure the argument; reviewing panels stress-test it.
Every role has a narrow lens, none of them try to "do everything".

Each role's output each round is a small JSON object:

```json
{
  "visionNotes": "≤ 2 sentences observation through this role's lens, or ''",
  "needsResearch": [{"query": "...", "rationale": "..."}]
}
```

The panel's job is to steer the vision + propose research when the wiki has coverage gaps.

## Who fires when

| Phase      | Roles                                                   |
| ---------- | ------------------------------------------------------- |
| ideation   | Explorer · Scoper · Stakes-Raiser                       |
| planning   | Architect · Evidence Scout · Steelman · Skeptic         |
| reviewing  | Adversary · Editor · Audience · Finaliser               |
| done       | (no panel, drafter runs instead)                       |

## Ideation panel, opening doors

**Explorer**
Expand the problem space. Look for adjacent angles, analogies, framings,
or sub-topics the vision has not considered. When the thesis is vague,
propose concrete directions it could take. Opens doors; does not close
them.

**Scoper**
Push the vision toward concreteness. Flag anything vague, a fuzzy
thesis, an unnamed audience, an abstract claim that needs a specific
example, a scope too broad for the length. Each note names one specific
abstraction and demands a specific answer.

**Stakes-Raiser**
Force "so what?" and "for whom?". If the stakes are unclear, the piece
has no reason to exist. Every note names a stake that's missing or
under-articulated.

## Planning panel, structuring the argument

**Argument Architect**
Propose or stress-test the thesis chain, the sub-claims that must hold
for the main claim to hold. Flag where the chain breaks, where a
sub-claim is load-bearing but unsupported, where a better framing
exists.

**Evidence Scout**
Identify claims the piece makes (or will make) that need external
evidence. Notes and research requests point to gaps in the wiki.
Prefers primary sources, papers, official docs, firsthand accounts.

**Steelman**
Construct the strongest opposing position to the emerging thesis. State
it charitably and accurately. Then check whether the vision has a
response, if not, that's high-severity: the piece will fall to this
objection unless it's addressed.

**Skeptic**
Find claims that would collapse under pressure, unstated assumptions,
weak evidence, logical gaps, overreach. Names a specific claim and the
specific failure mode. Does not raise stylistic issues (that's the
Editor's job).

## Reviewing panel, stress-testing

**Adversary**
Read the piece as a hostile reviewer would. Where is the argument most
vulnerable? What will a reader attack first? What question will stop
them dead on first read? Framing: "a hostile reader will say: …".

**Editor**
Look for redundancy, broken through-lines, pacing problems, and
coherence gaps in the section structure. Names specific sections or
beats and why they don't carry their weight. Suggests cuts and
reorderings.

**Audience**
Inhabit the stated reader. What will land? What will confuse? What do
they already know (so don't belabour it)? What do they not know (so
explain it)? Predicts the reader's reaction to specific passages.

**Finaliser**
Propose the concrete section-by-section beat sheet the drafter will
use. Each beat is a short "BEAT: <title>, <intent>" line. 4–8 beats in
reading order. The Chair folds these into the final vision.

## What users see

Each Chair summary carries its round's full panel output. The UI
surfaces it under the Chair's reply as a collapsed **Panel discussion**
accordion, click to expand and see each role's note + research
requests. Silent roles (no notes this round) are still listed, greyed
out, so you can tell they ran and had nothing to add vs. they didn't
fire at all.

## The Chair

The Chair is separate, it runs AFTER the panel each round, reads every
role's output, and emits:

- a short conversational summary to the user
- an optional vision.md rewrite (only when the round genuinely moves
  the thesis)
- 0–3 targeted questions when a judgment call needs the user
- a `requirementsPatch` when the user's last answers touched a hard
  requirement (word count, form, audience)

The Chair does NOT touch the anchor log. The Chair does NOT curate
panel findings. Its job is steering, synthesising, and keeping the
conversation with the user going.
