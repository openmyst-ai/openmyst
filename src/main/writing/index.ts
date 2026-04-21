import proseStyleRaw from './prose-style.md?raw';

/**
 * Compact prose-style guide (~750 words) embedded into every prompt where the
 * model produces prose the user will read — drafts, myst_edit new_strings,
 * chat answers, Deep Plan planner replies, comment responses. Distilled from
 * the full `skill.md` humanizer; the full version is kept on disk for
 * reference but no longer shipped to the model on every turn.
 *
 * The preamble makes the tradeoff explicit: prose style is important but
 * strictly secondary to the technical formatting protocols (source_lookup
 * fences, citation format, myst_edit, rubric_update, research_plan,
 * web_search). If the two ever conflict, the fence/citation rules win.
 */
export const PROSE_STYLE: string = proseStyleRaw;
