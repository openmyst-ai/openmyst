import { describe, it, expect } from 'vitest';
import {
  tick,
  runStatic,
  syncNodes,
  toArray,
  type SimEdge,
  type SimNode,
  type SimParams,
} from '../forceSim';

/**
 * Tests cover the physics contract and — crucially — the position-preservation
 * contract of `syncNodes`. The hover-shift bug lived in the latter: callers
 * used to re-seed every node on every graph change, so any `bridge.sources
 * .onChanged` event during hover made the whole layout jump. These tests
 * pin the invariants that keep it from regressing.
 */

const PARAMS: SimParams = {
  width: 400,
  height: 400,
  repulsion: 1000,
  spring: 0.05,
  springLength: 100,
  centerGravity: 0.01,
  damping: 0.85,
};

function node(id: string, x: number, y: number): SimNode {
  return { id, x, y, vx: 0, vy: 0 };
}

describe('forceSim.tick', () => {
  it('pushes two co-located nodes apart via repulsion', () => {
    const a = node('a', 200, 200);
    const b = node('b', 200.01, 200);
    tick([a, b], [], PARAMS);
    // Repulsion integrated into velocity then damped; after one tick they
    // should have a non-zero horizontal separation impulse.
    expect(Math.abs(a.vx)).toBeGreaterThan(0);
    expect(Math.sign(a.vx)).toBe(-Math.sign(b.vx));
  });

  it('pulls two far-apart nodes toward each other along a spring', () => {
    const a = node('a', 100, 200);
    const b = node('b', 300, 200);
    const edges: SimEdge[] = [{ source: 'a', target: 'b' }];
    const startDist = Math.hypot(a.x - b.x, a.y - b.y);

    // Repulsion at 200px with coef 1000 is 0.025 units of force — dwarfed
    // by the spring at 100 units of stretch × 0.05 stiffness = 5. The
    // spring dominates, so the nodes move inward after enough ticks.
    for (let i = 0; i < 30; i++) tick([a, b], edges, PARAMS);
    const endDist = Math.hypot(a.x - b.x, a.y - b.y);
    expect(endDist).toBeLessThan(startDist);
  });

  it('leaves a pinned node stationary', () => {
    const root = node('root', 50, 50);
    const other = node('other', 200, 200);
    const edges: SimEdge[] = [{ source: 'root', target: 'other' }];
    for (let i = 0; i < 50; i++) {
      tick([root, other], edges, PARAMS, new Set(['root']));
    }
    expect(root.x).toBe(50);
    expect(root.y).toBe(50);
    expect(root.vx).toBe(0);
    expect(root.vy).toBe(0);
  });

  it('pulls an isolated node toward the center via gravity', () => {
    const a = node('a', 20, 20);
    for (let i = 0; i < 200; i++) tick([a], [], PARAMS);
    // Center is (200, 200). Should be much closer than the start.
    expect(Math.hypot(a.x - 200, a.y - 200)).toBeLessThan(
      Math.hypot(20 - 200, 20 - 200),
    );
  });

  it('supports a per-edge spring-length function', () => {
    const a = node('a', 100, 200);
    const b = node('b', 300, 200);
    const c = node('c', 200, 400);
    const edges: SimEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ];
    // a→b wants to be short, a→c wants to be long.
    const springLength = (e: SimEdge): number =>
      e.target === 'b' ? 30 : 250;
    const params: SimParams = { ...PARAMS, springLength };
    for (let i = 0; i < 200; i++) tick([a, b, c], edges, params);
    const abDist = Math.hypot(a.x - b.x, a.y - b.y);
    const acDist = Math.hypot(a.x - c.x, a.y - c.y);
    expect(abDist).toBeLessThan(acDist);
  });
});

describe('forceSim.runStatic', () => {
  it('runs N ticks', () => {
    const a = node('a', 200, 200);
    const b = node('b', 200.01, 200);
    runStatic([a, b], [], PARAMS, 10);
    // After 10 ticks of repulsion from near-zero start, they should have
    // separated meaningfully.
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(0.1);
  });
});

describe('forceSim.syncNodes (position-preservation contract)', () => {
  it('preserves positions when the same node set is re-synced', () => {
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a', 'b', 'c'], PARAMS);
    const before = new Map(
      [...positions].map(([id, n]) => [id, { x: n.x, y: n.y }]),
    );
    // Same ids, different array identity — simulates a fresh WikiGraph
    // object with unchanged content.
    const added = syncNodes(positions, ['a', 'b', 'c'], PARAMS);
    expect(added).toBe(0);
    for (const [id, pos] of before) {
      const now = positions.get(id)!;
      expect(now.x).toBe(pos.x);
      expect(now.y).toBe(pos.y);
    }
  });

  it('adds only missing nodes when one is new', () => {
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a', 'b'], PARAMS);
    const aBefore = { ...positions.get('a')! };
    const bBefore = { ...positions.get('b')! };

    const added = syncNodes(positions, ['a', 'b', 'c'], PARAMS);
    expect(added).toBe(1);
    // a and b are untouched — this is the regression guard for the
    // hover-shift / re-layout-on-ingest bug.
    expect(positions.get('a')!.x).toBe(aBefore.x);
    expect(positions.get('a')!.y).toBe(aBefore.y);
    expect(positions.get('b')!.x).toBe(bBefore.x);
    expect(positions.get('b')!.y).toBe(bBefore.y);
    expect(positions.has('c')).toBe(true);
  });

  it('drops stale nodes', () => {
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a', 'b', 'c'], PARAMS);
    syncNodes(positions, ['a', 'c'], PARAMS);
    expect(positions.has('a')).toBe(true);
    expect(positions.has('b')).toBe(false);
    expect(positions.has('c')).toBe(true);
  });

  it('seeds new nodes on the seed circle near center', () => {
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a'], PARAMS, { seedRadius: 80 });
    const a = positions.get('a')!;
    // Center is (200, 200); a single new node lands at angle 0 → (280, 200).
    expect(a.x).toBeCloseTo(280);
    expect(a.y).toBeCloseTo(200);
  });

  it('returns to empty when nodeIds is empty', () => {
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a', 'b'], PARAMS);
    syncNodes(positions, [], PARAMS);
    expect(positions.size).toBe(0);
  });

  it('applies jitter deterministically to multiple new nodes', () => {
    const positions = new Map<string, SimNode>();
    // jitter 0 → nodes sit exactly on the seed circle in index order.
    syncNodes(positions, ['a', 'b'], PARAMS, { seedRadius: 100, jitter: 0 });
    const a = positions.get('a')!;
    const b = positions.get('b')!;
    // index 0 angle 0 → (300, 200); index 1 angle π → (100, 200).
    expect(a.x).toBeCloseTo(300);
    expect(b.x).toBeCloseTo(100);
  });
});

describe('forceSim.toArray', () => {
  it('returns positions in the order of nodeIds', () => {
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a', 'b', 'c'], PARAMS);
    const arr = toArray(positions, ['c', 'a']);
    expect(arr.map((n) => n.id)).toEqual(['c', 'a']);
  });

  it('skips ids not present in the map', () => {
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a'], PARAMS);
    const arr = toArray(positions, ['a', 'missing']);
    expect(arr.map((n) => n.id)).toEqual(['a']);
  });
});

describe('forceSim — regression: re-settle after add does not teleport existing nodes', () => {
  it('preserves an existing node roughly in place when a new one is added', () => {
    // Simulates the real Deep Plan flow: initial graph with two nodes
    // settles, then a third node appears (a new source ingest). Before
    // the fix, this re-seeded everything onto the index circle. Now the
    // existing two should move only a little during the delta re-settle.
    const positions = new Map<string, SimNode>();
    syncNodes(positions, ['a', 'b'], PARAMS);
    runStatic(Array.from(positions.values()), [], PARAMS, 200);
    const aAfterFirstSettle = { ...positions.get('a')! };

    syncNodes(positions, ['a', 'b', 'c'], PARAMS);
    runStatic(Array.from(positions.values()), [], PARAMS, 80);
    const aAfterDelta = positions.get('a')!;

    // Tolerance is generous — the point is "didn't teleport to an
    // index-based circle", not "didn't move at all". In the buggy version
    // `a` would have been reset to seedRadius × cos(0) = 320 flat.
    const shift = Math.hypot(
      aAfterDelta.x - aAfterFirstSettle.x,
      aAfterDelta.y - aAfterFirstSettle.y,
    );
    expect(shift).toBeLessThan(40);
  });
});
