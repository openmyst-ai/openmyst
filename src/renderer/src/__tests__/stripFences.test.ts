import { describe, it, expect } from 'vitest';
import { stripDeepPlanFences } from '../components/deepPlan/stripFences';

/**
 * `stripDeepPlanFences` is the last line of defence before planner output
 * hits the screen. It must handle: fully-closed fenced blocks, in-progress
 * unclosed fences (streaming), AND — the bug we're guarding — a bare
 * trailing JSON object the model emitted without a fence. The server-side
 * parser also strips these now, but this covers in-flight streams and any
 * messages persisted before the parser fix.
 */
describe('stripDeepPlanFences — fenced blocks', () => {
  it('removes a closed rubric_update fence', () => {
    const text = [
      'Questions.',
      '',
      '```rubric_update',
      '{"form": "essay"}',
      '```',
    ].join('\n');
    const { visible, isWriting } = stripDeepPlanFences(text);
    expect(visible).toBe('Questions.');
    expect(isWriting).toBe(false);
  });

  it('hides an in-progress rubric_update fence as "writing"', () => {
    const text = ['Questions.', '', '```rubric_update', '{"form":'].join('\n');
    const { visible, isWriting } = stripDeepPlanFences(text);
    expect(visible).toBe('Questions.');
    expect(isWriting).toBe(true);
  });

  it('removes a research_plan block', () => {
    const text = [
      'Planning.',
      '',
      '```research_plan',
      '[{"query": "x", "rationale": "y"}]',
      '```',
    ].join('\n');
    const { visible } = stripDeepPlanFences(text);
    expect(visible).toBe('Planning.');
  });
});

describe('stripDeepPlanFences — bare trailing JSON fallback', () => {
  it('strips a bare trailing JSON object (forgotten fence)', () => {
    const text = [
      "Hit Continue when you're happy with these.",
      '',
      '{',
      '  "must_cover": ["Jetson Orin"],',
      '  "must_avoid": ["OAK-D"]',
      '}',
    ].join('\n');
    const { visible, isWriting } = stripDeepPlanFences(text);
    expect(visible).toBe("Hit Continue when you're happy with these.");
    expect(isWriting).toBe(false);
  });

  it('treats unbalanced trailing JSON as in-progress (streaming)', () => {
    const text = ['Questions.', '', '{', '  "must_cover": [', '    "Jetson"'].join(
      '\n',
    );
    const { visible, isWriting } = stripDeepPlanFences(text);
    expect(visible).toBe('Questions.');
    expect(isWriting).toBe(true);
  });

  it('leaves inline braces alone', () => {
    const text = 'Pick a set like {a, b, c} and continue.';
    const { visible, isWriting } = stripDeepPlanFences(text);
    expect(visible).toBe(text);
    expect(isWriting).toBe(false);
  });

  it('handles string-embedded braces in the trailing JSON correctly', () => {
    const text = ['Hi.', '', '{"notes": "set {x} is {y}"}'].join('\n');
    const { visible } = stripDeepPlanFences(text);
    expect(visible).toBe('Hi.');
  });

  it('returns empty visible when a message is nothing but JSON', () => {
    const text = '{"form": "essay"}';
    const { visible } = stripDeepPlanFences(text);
    expect(visible).toBe('');
  });
});
