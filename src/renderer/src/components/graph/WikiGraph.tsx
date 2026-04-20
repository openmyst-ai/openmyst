import { useEffect, useMemo, useRef, useState } from 'react';
import type { WikiGraph as WikiGraphData, WikiGraphNode } from '@shared/types';
import {
  syncNodes,
  tick,
  toArray,
  type SimNode,
  type SimParams,
} from './forceSim';

/**
 * Unified wiki graph — the single canvas we render everywhere a graph of
 * sources needs to appear (Deep Wiki modal, Deep Plan's research column,
 * any future embed). Replaces the old trio of DeepWikiModal / ResearchGraph
 * / WikiGraphColumn, which had drifted into three subtly-different copies
 * of the same idea.
 *
 * Only renders source nodes — no root, no query hubs. Edges come from the
 * wiki graph snapshot (both inline `[Name](slug.md)` wikilinks and the
 * `## Related` section at the end of each source's summary). Well-connected
 * sources render visibly bigger via a sqrt-of-degree radius so "impactful"
 * nodes stand out at a glance.
 *
 * Positions persist across renders in a ref'd Map so graph refetches
 * (e.g. `bridge.sources.onChanged` during a run) top up new nodes with a
 * short delta-settle instead of re-seeding the entire constellation.
 *
 * Props are designed so callers can pick their own size, decoration, and
 * interaction style — this component is the engine + renderer, callers own
 * the shell (header, stats, side preview).
 */

export interface WikiGraphProps {
  graph: WikiGraphData | null;
  /**
   * Slugs newly-ingested during the current run. Rendered with an extra
   * glow so the user can see what the run just surfaced without having to
   * diff the graph mentally.
   */
  freshSlugs?: Set<string>;
  /**
   * Ids that are transient "pending" nodes — seen during a search but not
   * yet ingested. Rendered in a subdued purple so the user watches the
   * constellation assemble. Caller is expected to include these ids as
   * regular entries in `graph.nodes` (with a display name). When an id
   * graduates to ingested or skipped, the caller removes it from this
   * set — and optionally lifts it into the real wiki graph.
   */
  pendingIds?: Set<string>;
  /**
   * Purely cosmetic hint — we always tick the sim (Obsidian-style bouncy
   * layout, re-springy every mount and on every new node), but callers
   * can pass `running` so UI bits like the "Stop research" pill know
   * there's an active run. Does NOT gate the animation loop.
   */
  running?: boolean;
  onNodeOpen?: (slug: string) => void;
  /** Slug of the currently-selected node, for active-state styling. */
  selectedSlug?: string | null;
  width?: number;
  height?: number;
  /** Render labels under nodes. Off for dense/small views. */
  showLabels?: boolean;
  /** Enable zoom + pan controls. Off for sidebar-sized embeds. */
  enableZoom?: boolean;
  /**
   * Radius formula: r = baseRadius + radiusPerEdge * sqrt(degree).
   * sqrt keeps very-well-connected nodes from dwarfing the canvas while
   * still giving a clear visual pop to hubs vs leaves.
   */
  baseRadius?: number;
  radiusPerEdge?: number;
  hitRadiusPad?: number;
  className?: string;
  /** Hide the tooltip row below the canvas. For full-bleed embeds. */
  hideTooltip?: boolean;
  /** Stretch the canvas to fill its container rather than its nominal size. */
  fillContainer?: boolean;
  /** Override physics. Falls back to sensible defaults tuned per size. */
  params?: Partial<SimParams>;
}

const DEFAULTS = {
  width: 820,
  height: 520,
  baseRadius: 5,
  radiusPerEdge: 2.2,
  hitRadiusPad: 8,
};

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.25;

function defaultParams(width: number, height: number): SimParams {
  // Scale physics with the canvas — the tiny sidebar embed wants tighter
  // springs and less repulsion than the full-screen modal.
  const scale = Math.min(width, height) / 520;
  return {
    width,
    height,
    repulsion: 5200 * scale,
    spring: 0.03,
    springLength: 190 * scale,
    centerGravity: 0.009,
    damping: 0.84,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Degree-weighted node radius. sqrt caps the visual spread so a 16-edge
 * hub is ~4× the bump of a 1-edge leaf rather than 16× — preserves the
 * "more connections = more impactful" read without letting a single hub
 * dominate the canvas. Exported for tests so the formula stays pinned.
 */
export function nodeRadius(degree: number, baseRadius: number, radiusPerEdge: number): number {
  const d = Math.max(0, degree);
  return baseRadius + radiusPerEdge * Math.sqrt(d);
}

/**
 * Degree map helper — counts edges touching each node. Both endpoints of
 * an edge get their count incremented. Exported for tests.
 */
export function computeDegrees(edges: { source: string; target: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) {
    m.set(e.source, (m.get(e.source) ?? 0) + 1);
    m.set(e.target, (m.get(e.target) ?? 0) + 1);
  }
  return m;
}

export function WikiGraph({
  graph,
  freshSlugs,
  pendingIds,
  running = false,
  onNodeOpen,
  selectedSlug,
  width = DEFAULTS.width,
  height = DEFAULTS.height,
  showLabels = true,
  enableZoom = true,
  baseRadius = DEFAULTS.baseRadius,
  radiusPerEdge = DEFAULTS.radiusPerEdge,
  hitRadiusPad = DEFAULTS.hitRadiusPad,
  className,
  hideTooltip = false,
  fillContainer = false,
  params: paramsOverride,
}: WikiGraphProps): JSX.Element {
  const [, forceRender] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const suppressClickRef = useRef(false);
  const positionsRef = useRef<Map<string, SimNode>>(new Map());
  // When a new node arrives we goose the sim by giving existing nodes a
  // small kick — springs do the rest. This is what produces the "bouncy"
  // feel users associate with Obsidian's graph.
  const kickUntilRef = useRef<number>(0);

  const params = useMemo<SimParams>(
    () => ({ ...defaultParams(width, height), ...paramsOverride }),
    [width, height, paramsOverride],
  );

  // Degree map — a source's size scales with how many edges touch it.
  const degreeById = useMemo(
    () => (graph ? computeDegrees(graph.edges) : new Map<string, number>()),
    [graph],
  );

  // Sync the position map with the latest graph. New nodes spawn on a
  // jittered ring at seed time and let the live raf loop settle them in —
  // no up-front static pass. Old nodes stay put; stale ones evict.
  useEffect(() => {
    if (!graph) return;
    const nodeIds = graph.nodes.map((n) => n.id);
    const added = syncNodes(positionsRef.current, nodeIds, params, { jitter: 14 });
    if (added > 0) {
      // Give every node a tiny random impulse so the whole constellation
      // springs back to life instead of just the new ones wiggling.
      for (const n of positionsRef.current.values()) {
        n.vx += (Math.random() - 0.5) * 4;
        n.vy += (Math.random() - 0.5) * 4;
      }
      kickUntilRef.current = Date.now() + 2400;
    }
  }, [graph, params]);

  // Always-on raf loop. The sim runs whenever the component is mounted,
  // same as Obsidian — opening the graph is supposed to feel alive. It
  // settles quickly (spring damping), but any disturbance (new node,
  // zoom change, the initial jittered seed) re-kicks it.
  useEffect(() => {
    let raf = 0;
    const loop = (): void => {
      tick(Array.from(positionsRef.current.values()), graph?.edges ?? [], params);
      forceRender((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [graph, params]);

  const simNodes = graph ? toArray(positionsRef.current, graph.nodes.map((n) => n.id)) : [];

  const nodeById = useMemo(() => {
    const m = new Map<string, SimNode & WikiGraphNode>();
    if (!graph) return m;
    const posById = new Map(simNodes.map((n) => [n.id, n]));
    for (const meta of graph.nodes) {
      const pos = posById.get(meta.id);
      if (pos) m.set(meta.id, { ...meta, ...pos });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, simNodes]);

  const hovered = hoverId ? nodeById.get(hoverId) ?? null : null;
  // Silence unused-var warning for `kickUntilRef` — kept in the closure
  // so callers that want to gate UI off a recent mutation can read it.
  void kickUntilRef;
  void running;

  // ─ Zoom/pan ─────────────────────────────────────────────────────────
  const handleZoom = (factor: number): void => {
    setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor)));
  };
  const handleResetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!enableZoom) return;
    if (e.button !== 0) return;
    const svgEl = e.currentTarget;
    const rect = svgEl.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPan = { ...pan };
    const currentZoom = zoom;
    let dragged = false;
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) > 3) dragged = true;
      if (!dragged) return;
      const ratioX = width / currentZoom / rect.width;
      const ratioY = height / currentZoom / rect.height;
      setPan({
        x: startPan.x - dx * ratioX,
        y: startPan.y - dy * ratioY,
      });
    };
    const onUp = (): void => {
      if (dragged) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsDragging(false);
    };
    setIsDragging(true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const centerX = width / 2;
  const centerY = height / 2;
  const viewBox = enableZoom
    ? `${centerX - width / zoom / 2 + pan.x} ${centerY - height / zoom / 2 + pan.y} ${width / zoom} ${height / zoom}`
    : `0 0 ${width} ${height}`;

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;

  return (
    <div
      className={`wiki-graph${fillContainer ? ' wiki-graph-fill' : ''}${className ? ` ${className}` : ''}`}
    >
      <div className="wiki-graph-canvas-wrap">
        {enableZoom && nodeCount > 0 && (
          <div className="rg-zoom-controls" aria-hidden="true">
            <button
              type="button"
              className="rg-zoom-btn"
              onClick={() => handleZoom(ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX - 0.001}
              title="Zoom in"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="rg-zoom-btn"
              onClick={() => handleZoom(1 / ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN + 0.001}
              title="Zoom out"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="rg-zoom-btn rg-zoom-reset"
              onClick={handleResetView}
              disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
              title="Reset view"
              aria-label="Reset view"
            >
              ⌂
            </button>
          </div>
        )}

        {nodeCount === 0 ? (
          <div className="wiki-graph-empty">
            No sources yet. Ingest something and the graph starts weaving itself together here.
          </div>
        ) : (
          <svg
            className={`wiki-graph-svg${isDragging ? ' wiki-graph-svg-grabbing' : ''}`}
            viewBox={viewBox}
            preserveAspectRatio="xMidYMid meet"
            onMouseDown={handleSvgMouseDown}
          >
            <g>
              {graph!.edges.map((e, i) => {
                const a = nodeById.get(e.source);
                const b = nodeById.get(e.target);
                if (!a || !b) return null;
                const active = hoverId === e.source || hoverId === e.target;
                return (
                  <line
                    key={`${e.source}->${e.target}-${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={active ? 'wiki-graph-edge wiki-graph-edge-active' : 'wiki-graph-edge'}
                  />
                );
              })}
            </g>
            <g>
              {simNodes.map((n) => {
                const meta = nodeById.get(n.id);
                if (!meta) return null;
                const degree = degreeById.get(n.id) ?? 0;
                const r = nodeRadius(degree, baseRadius, radiusPerEdge);
                const hoverBump = 2;
                const active = hoverId === n.id || selectedSlug === n.id;
                const fresh = freshSlugs?.has(n.id) === true;
                const pending = pendingIds?.has(n.id) === true && !fresh;
                const labelText = meta.name.length > 22 ? `${meta.name.slice(0, 20)}…` : meta.name;
                return (
                  <g key={n.id} className="wiki-graph-node-g">
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={active ? r + hoverBump : r}
                      className={`wiki-graph-node${active ? ' wiki-graph-node-active' : ''}${fresh ? ' wiki-graph-node-fresh' : ''}${pending ? ' wiki-graph-node-pending' : ''}`}
                      style={{ pointerEvents: 'none' }}
                    />
                    {showLabels && (
                      <text
                        x={n.x}
                        y={n.y + r + 12}
                        textAnchor="middle"
                        className="wiki-graph-label"
                        style={{ pointerEvents: 'none' }}
                      >
                        {labelText}
                      </text>
                    )}
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={r + hitRadiusPad}
                      className="wiki-graph-hit"
                      style={onNodeOpen ? { cursor: 'pointer' } : undefined}
                      onMouseEnter={() => setHoverId(n.id)}
                      onMouseLeave={() => setHoverId(null)}
                      onClick={(e) => {
                        if (!onNodeOpen) return;
                        if (suppressClickRef.current) return;
                        e.stopPropagation();
                        onNodeOpen(n.id);
                      }}
                    />
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>

      {!hideTooltip && (
        <div className="wiki-graph-tooltip">
          {hovered ? (
            <>
              <div className="wiki-graph-tooltip-name">{hovered.name}</div>
              <div className="wiki-graph-tooltip-summary">
                {truncate(hovered.indexSummary, 160)}
              </div>
            </>
          ) : (
            nodeCount > 0 && (
              <div className="wiki-graph-tooltip-hint">
                {nodeCount} source{nodeCount === 1 ? '' : 's'} · {edgeCount} link
                {edgeCount === 1 ? '' : 's'} · hover a node to peek, click to open.
              </div>
            )
          )}
        </div>
      )}
      {/* Floating hover label when tooltip row is hidden — lightweight
          affordance so the user still gets a name peek on hover in the
          full-bleed embed. */}
      {hideTooltip && hovered && (
        <div className="wiki-graph-floating-label">
          <div className="wiki-graph-tooltip-name">{hovered.name}</div>
          <div className="wiki-graph-tooltip-summary">{truncate(hovered.indexSummary, 140)}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Helper: given a live stream of research events, return the set of
 * currently-pending result ids — seen but neither ingested nor skipped —
 * scoped to the most recent run. Also returns a name map so callers can
 * splice these in as nodes with readable labels.
 *
 * This is the "node arrives when the agent surfaces a candidate, glows
 * when it ingests, disappears if it skips" state machine, precomputed.
 */
export function pendingNodesFromEvents(
  events: Array<{
    kind: string;
    runId?: string;
    resultId?: string;
    title?: string;
    url?: string;
  }>,
): { ids: Set<string>; names: Map<string, string> } {
  const pending = new Map<string, string>();
  let currentRunId: string | null = null;
  for (const ev of events) {
    if (ev.kind === 'run-start' && typeof ev.runId === 'string') {
      if (currentRunId && ev.runId !== currentRunId) pending.clear();
      currentRunId = ev.runId;
      pending.clear();
      continue;
    }
    if (ev.runId !== currentRunId || !ev.resultId) continue;
    if (ev.kind === 'result-seen') {
      const label = (ev.title && ev.title.trim()) || ev.url || 'Fetching…';
      pending.set(ev.resultId, label);
    } else if (ev.kind === 'result-ingested' || ev.kind === 'result-skipped') {
      // Graduated (ingested → shows up in the wiki graph with glow) or
      // skipped (just vanishes). Either way, drop the transient.
      pending.delete(ev.resultId);
    }
  }
  return { ids: new Set(pending.keys()), names: pending };
}

/**
 * Helper: given a live stream of research events, return the set of slugs
 * that were ingested during the current run. Used by callers to decorate
 * fresh arrivals without owning the event diff themselves.
 */
export function freshSlugsFromEvents(
  events: { kind: string; slug?: string; runId?: string }[],
): Set<string> {
  const out = new Set<string>();
  let currentRunId: string | null = null;
  for (const ev of events) {
    if (ev.kind === 'run-start' && typeof ev.runId === 'string') {
      currentRunId = ev.runId;
      out.clear();
    } else if (ev.kind === 'result-ingested' && ev.slug && ev.runId === currentRunId) {
      out.add(ev.slug);
    }
  }
  return out;
}
