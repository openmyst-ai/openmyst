import { describe, it, expect } from 'vitest';
import { parsePlannerReply } from '../features/deepPlan/parse';

/**
 * These tests pin the contract that the planner's user-facing chat never
 * leaks structured content. The bug we're guarding against: during the
 * clarify stage the model sometimes forgot the `rubric_update` fence and
 * emitted bare JSON at the end of its reply, so the raw JSON object ended
 * up rendered to the user. Any regression here is user-visible.
 */
describe('parsePlannerReply — rubric fence (happy path)', () => {
  it('extracts a fenced rubric_update and strips it from chat', () => {
    const raw = [
      'Here are some questions.',
      '',
      '```rubric_update',
      '{"form": "essay", "audience": "general readers"}',
      '```',
    ].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe('Here are some questions.');
    expect(out.rubricPatch).toEqual({
      form: 'essay',
      audience: 'general readers',
    });
  });

  it('ignores a malformed fenced JSON block but still strips the fence', () => {
    const raw = [
      'Questions here.',
      '',
      '```rubric_update',
      '{not valid json',
      '```',
    ].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe('Questions here.');
    expect(out.rubricPatch).toBeNull();
  });
});

describe('parsePlannerReply — bare trailing JSON fallback', () => {
  it('strips a bare trailing JSON object and still extracts the rubric patch', () => {
    const raw = [
      "Hit Continue when you're happy with these.",
      '',
      '{',
      '  "mustCover": ["Jetson Orin", "Pi 5"],',
      '  "mustAvoid": ["OAK-D"]',
      '}',
    ].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe("Hit Continue when you're happy with these.");
    expect(out.rubricPatch).toEqual({
      mustCover: ['Jetson Orin', 'Pi 5'],
      mustAvoid: ['OAK-D'],
    });
  });

  it('accepts snake_case keys from the model', () => {
    const raw = [
      '1. Question?',
      '2. Another?',
      '',
      '{"must_cover": ["a", "b"], "must_avoid": ["c"], "length_target": "1500 words"}',
    ].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.chat).toContain('1. Question');
    expect(out.chat).not.toContain('must_cover');
    expect(out.rubricPatch).toEqual({
      mustCover: ['a', 'b'],
      mustAvoid: ['c'],
      lengthTarget: '1500 words',
    });
  });

  it('strips bare JSON even when it is not a valid rubric patch', () => {
    // Model hallucinates some unrelated object — hide it but don't patch.
    const raw = [
      'Some prose.',
      '',
      '{"some_unrelated_field": 42}',
    ].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe('Some prose.');
    expect(out.rubricPatch).toBeNull();
  });

  it('does not strip inline braces in prose', () => {
    // Braces in the middle of a sentence must be left alone.
    const raw =
      'The set {1, 2, 3} has three elements, and so does the set {a, b, c}.';
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe(raw);
  });

  it('prefers the fenced block when both are present', () => {
    const raw = [
      'Questions.',
      '',
      '```rubric_update',
      '{"form": "essay"}',
      '```',
      '',
      '{"mustCover": ["ignored"]}',
    ].join('\n');
    const out = parsePlannerReply(raw);
    // Fenced block wins; trailing JSON is NOT additionally salvaged
    // because we only fall back when no fence matched. It should still
    // be visible to the user though — the parser's job on the fallback
    // path is hiding bare JSON; when the fence is present we expect the
    // model obeyed the format and any other braces are prose.
    expect(out.rubricPatch).toEqual({ form: 'essay' });
  });

  it('handles nested JSON correctly', () => {
    const raw = [
      'Done.',
      '',
      '{"notes": "see {this} inline", "mustCover": ["a"]}',
    ].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe('Done.');
    expect(out.rubricPatch).toEqual({
      notes: 'see {this} inline',
      mustCover: ['a'],
    });
  });

  it('handles a trailing array as well as a trailing object', () => {
    const raw = ['Prose.', '', '[1, 2, 3]'].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe('Prose.');
    // Array can't be a rubric patch, so patch stays null; but the
    // visible chat is cleaned up.
    expect(out.rubricPatch).toBeNull();
  });

  it('leaves chat untouched when there is no trailing JSON', () => {
    const raw = "Hit Continue when you're happy with these.";
    const out = parsePlannerReply(raw);
    expect(out.chat).toBe(raw);
    expect(out.rubricPatch).toBeNull();
  });
});

describe('parsePlannerReply — research_plan', () => {
  it('extracts a fenced research plan and strips it from chat', () => {
    const raw = [
      '```research_plan',
      '[{"query": "edge inference benchmarks", "rationale": "coverage"}]',
      '```',
    ].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.researchPlan).toEqual([
      { query: 'edge inference benchmarks', rationale: 'coverage' },
    ]);
    expect(out.chat).toBe('');
  });

  it('returns an empty plan when the model emits an empty array', () => {
    const raw = ['```research_plan', '[]', '```'].join('\n');
    const out = parsePlannerReply(raw);
    expect(out.researchPlan).toEqual([]);
  });
});
