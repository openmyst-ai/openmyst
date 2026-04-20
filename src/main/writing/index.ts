import skillRaw from './skill.md?raw';

/**
 * Writing-style guide embedded into any prompt where the model is producing
 * prose the user will actually read — full draft generation, edit proposals,
 * etc. Kept out of conversational prompts (planner stages, general chat)
 * where the model is collaborating rather than writing.
 *
 * Source: `src/main/writing/skill.md` (based on the Wikipedia "Signs of AI
 * writing" guide). Edit that file to tune behavior — it lands here via
 * Vite's `?raw` import at build time, no rebuild-of-code needed.
 */
export const WRITING_SKILL: string = skillRaw;
