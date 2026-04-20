/**
 * Shared 2D force-directed layout used by every graph view in the app
 * (Deep Plan wiki column, Deep Wiki modal, Research graph). Extracted out
 * so a single bug-fix / tuning change lands everywhere at once and the
 * physics behaviour can be unit tested in isolation.
 *
 * The engine is deliberately tiny — no d3-force dependency. Every graph
 * view worked from hand-rolled copies of the same loop; this module is
 * that loop, parametrised.
 *
 * Not React-aware. Callers keep their own `Map<id, SimNode>` (typically in
 * a ref) so positions survive across re-renders, and call `tick` or
 * `runStatic` as appropriate.
 *
 * Why positions-must-persist matters: the original `WikiGraphColumn` and
 * `DeepWikiModal` recomputed `simNodes` via `useMemo(..., [graph])`, which
 * seeded every node back onto an index-based circle and re-ran the full
 * simulation whenever the graph object changed. That made every existing
 * node jump to a new spot as soon as `bridge.sources.onChanged` fired —
 * the "hover shifts the graph into glitch mode" bug. The fix is to seed
 * only the nodes we haven't seen before (`seedMissing`) and leave
 * already-positioned nodes alone.
 */

export interface SimParams {
  width: number;
  height: number;
  /** Coulomb-ish pairwise repulsion coefficient. Bigger = more spread. */
  repulsion: number;
  /** Hooke spring stiffness for edges. */
  spring: number;
  /**
   * Per-edge rest length. Use a function when different edge classes want
   * different targets (e.g. query→result shorter than wiki→wiki).
   */
  springLength: number | ((edge: SimEdge) => number);
  /** Pull toward canvas center. Keeps disconnected components from drifting. */
  centerGravity: number;
  /** Velocity damping per tick. 0.8-0.9 is typical. */
  damping: number;
}

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface SimEdge {
  source: string;
  target: string;
}

/**
 * One physics step. Mutates node positions in place.
 *
 * `pinned` — ids whose position is locked (e.g. the root node in
 * `ResearchGraph`). Their velocity is zeroed, they receive no force, and
 * their x/y is left untouched by the integrator.
 */
export function tick(
  nodes: SimNode[],
  edges: SimEdge[],
  params: SimParams,
  pinned?: Set<string>,
): void {
  const byId = new Map<string, SimNode>();
  for (const n of nodes) byId.set(n.id, n);

  const centerX = params.width / 2;
  const centerY = params.height / 2;

  // Pairwise repulsion (O(n²) — fine for the hundreds-of-nodes scale we
  // operate at; Barnes-Hut isn't worth the complexity here).
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy || 0.01;
      const dist = Math.sqrt(distSq);
      const force = params.repulsion / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // Edge springs.
  const lengthFn =
    typeof params.springLength === 'function'
      ? params.springLength
      : (): number => params.springLength as number;
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const target = lengthFn(e);
    const delta = dist - target;
    const fx = (dx / dist) * delta * params.spring;
    const fy = (dy / dist) * delta * params.spring;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // Integrate. Pinned nodes are frozen.
  for (const n of nodes) {
    if (pinned && pinned.has(n.id)) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx += (centerX - n.x) * params.centerGravity;
    n.vy += (centerY - n.y) * params.centerGravity;
    n.vx *= params.damping;
    n.vy *= params.damping;
    n.x += n.vx;
    n.y += n.vy;
  }
}

/** Run `ticks` iterations synchronously — for static layouts (wiki views). */
export function runStatic(
  nodes: SimNode[],
  edges: SimEdge[],
  params: SimParams,
  ticks: number,
  pinned?: Set<string>,
): void {
  for (let t = 0; t < ticks; t++) {
    tick(nodes, edges, params, pinned);
  }
}

/**
 * Add `SimNode` entries for ids that aren't already in `positions`, and
 * drop entries for ids that no longer appear in `nodeIds`.
 *
 * New nodes are placed on an evenly-spaced circle around the center at
 * `seedRadius`, with a tiny random jitter so they don't overlap exactly
 * and the sim has something to push apart. When `positions` is empty
 * (first render), this is identical to the old index-based seed.
 *
 * Returns the number of new nodes added — useful for deciding whether to
 * run a settle pass.
 */
export function syncNodes(
  positions: Map<string, SimNode>,
  nodeIds: string[],
  params: SimParams,
  opts?: { seedRadius?: number; jitter?: number },
): number {
  const seedRadius =
    opts?.seedRadius ?? Math.min(params.width, params.height) * 0.3;
  const jitter = opts?.jitter ?? 0;
  const centerX = params.width / 2;
  const centerY = params.height / 2;

  const wanted = new Set(nodeIds);
  for (const id of positions.keys()) {
    if (!wanted.has(id)) positions.delete(id);
  }

  const missing: string[] = [];
  for (const id of nodeIds) {
    if (!positions.has(id)) missing.push(id);
  }

  for (let i = 0; i < missing.length; i++) {
    const id = missing[i]!;
    const angle = (2 * Math.PI * i) / Math.max(missing.length, 1);
    const jx = jitter ? (Math.random() - 0.5) * jitter : 0;
    const jy = jitter ? (Math.random() - 0.5) * jitter : 0;
    positions.set(id, {
      id,
      x: centerX + Math.cos(angle) * seedRadius + jx,
      y: centerY + Math.sin(angle) * seedRadius + jy,
      vx: 0,
      vy: 0,
    });
  }

  return missing.length;
}

/** Convenience: snapshot the map as a stable-ordered array matching `nodeIds`. */
export function toArray(
  positions: Map<string, SimNode>,
  nodeIds: string[],
): SimNode[] {
  const out: SimNode[] = [];
  for (const id of nodeIds) {
    const n = positions.get(id);
    if (n) out.push(n);
  }
  return out;
}
