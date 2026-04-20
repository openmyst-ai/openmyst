import { describe, it, expect } from 'vitest';
import { computeDegrees, nodeRadius, freshSlugsFromEvents } from '../WikiGraph';

/**
 * The user-visible promise of the unified wiki graph is "more connections
 * = bigger node". sqrt scaling is the load-bearing detail: without it a
 * hub with many edges dwarfs every leaf and the canvas unreadably tilts
 * toward a single source. Pin the formula here.
 */
describe('nodeRadius', () => {
  it('returns the base radius for a zero-degree node', () => {
    expect(nodeRadius(0, 5, 2)).toBe(5);
  });

  it('scales with sqrt(degree), not linearly', () => {
    const base = 4;
    const k = 2;
    const r1 = nodeRadius(1, base, k); // 4 + 2*1  = 6
    const r4 = nodeRadius(4, base, k); // 4 + 2*2  = 8
    const r16 = nodeRadius(16, base, k); // 4 + 2*4 = 12
    expect(r1).toBe(6);
    expect(r4).toBe(8);
    expect(r16).toBe(12);
    // Monotonic but sub-linear: doubling degree less than doubles radius.
    expect(r16 / r1).toBeLessThan(16);
  });

  it('treats negative degrees as zero (defensive)', () => {
    expect(nodeRadius(-3, 5, 2)).toBe(5);
  });

  it('obeys the exact formula r = base + k*sqrt(degree)', () => {
    for (const d of [0, 1, 2, 3, 9, 25, 100]) {
      expect(nodeRadius(d, 3, 1.5)).toBeCloseTo(3 + 1.5 * Math.sqrt(d));
    }
  });
});

describe('computeDegrees', () => {
  it('counts both endpoints of every edge', () => {
    const d = computeDegrees([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'a', target: 'c' },
    ]);
    expect(d.get('a')).toBe(2);
    expect(d.get('b')).toBe(2);
    expect(d.get('c')).toBe(2);
  });

  it('returns zero / missing for a node with no edges', () => {
    const d = computeDegrees([{ source: 'a', target: 'b' }]);
    expect(d.get('c')).toBeUndefined();
  });

  it('treats multi-edges as multiple counts (no dedupe here)', () => {
    // Dedupe happens upstream in `computeWikiGraph`. This helper is the
    // raw counter — if the same edge appears twice, both bumps count.
    const d = computeDegrees([
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b' },
    ]);
    expect(d.get('a')).toBe(2);
    expect(d.get('b')).toBe(2);
  });

  it('handles an empty edge list', () => {
    expect(computeDegrees([])).toEqual(new Map());
  });
});

describe('freshSlugsFromEvents', () => {
  // "Fresh this run" is the amber-glow set on the graph. It's scoped to
  // the most recent `run-start` event and only contains slugs ingested
  // under that runId — prior runs' ingestions don't carry over.
  it('collects slugs ingested under the current run', () => {
    const events = [
      { kind: 'run-start', runId: 'r1' },
      { kind: 'result-ingested', runId: 'r1', slug: 'a' },
      { kind: 'result-ingested', runId: 'r1', slug: 'b' },
    ];
    expect(Array.from(freshSlugsFromEvents(events)).sort()).toEqual(['a', 'b']);
  });

  it('clears the set at a new run-start and ignores prior ingestions', () => {
    const events = [
      { kind: 'run-start', runId: 'r1' },
      { kind: 'result-ingested', runId: 'r1', slug: 'a' },
      { kind: 'run-start', runId: 'r2' },
      { kind: 'result-ingested', runId: 'r2', slug: 'b' },
    ];
    expect(Array.from(freshSlugsFromEvents(events))).toEqual(['b']);
  });

  it('ignores ingestions whose runId does not match the current run', () => {
    // Out-of-band events (e.g. a stale event from a previous run after
    // the user restarted) must not leak into the fresh set.
    const events = [
      { kind: 'run-start', runId: 'r1' },
      { kind: 'result-ingested', runId: 'r0', slug: 'old' },
      { kind: 'result-ingested', runId: 'r1', slug: 'new' },
    ];
    expect(Array.from(freshSlugsFromEvents(events))).toEqual(['new']);
  });

  it('returns an empty set when no run has started', () => {
    const events = [{ kind: 'result-ingested', runId: 'r1', slug: 'a' }];
    expect(freshSlugsFromEvents(events).size).toBe(0);
  });
});
