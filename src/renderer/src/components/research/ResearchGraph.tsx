import { useEffect, useRef, useState } from 'react';
import type { DeepPlanResearchEvent, WikiGraph } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useSourcePreview } from '../../store/sourcePreview';
import { tick, type SimEdge, type SimParams } from '../graph/forceSim';

/**
 * Live, ticking force-directed graph of an in-flight research run. Nodes
 * get added as events land and the simulation keeps ticking for a few
 * seconds after the last mutation so layouts settle naturally.
 *
 * Layout:
 *   - "root" node at the center = the current task.
 *   - "query" nodes radiate from the root (one per planner-proposed query).
 *   - "result" nodes radiate from their parent query, colour-coded by status
 *     (pending/ingested/skipped).
 *
 * Deliberately no external deps — same hand-rolled sim pattern as
 * `WikiGraphModal`, but ticked every frame instead of frozen after N steps.
 */

interface Node {
  id: string;
  kind: 'root' | 'query' | 'result';
  /** Full, untruncated label — truncation happens at render time. */
  label: string;
  parentId: string | null;
  status?: 'pending' | 'ingested' | 'skipped';
  skipReason?: string;
  url?: string;
  /** Wiki slug, set once a result is ingested — lets us open its preview. */
  slug?: string;
  /** True only when the ingestion event belonged to the current run, so
   *  freshly-added sources can be highlighted distinctly. */
  freshThisRun?: boolean;
  /** True when the node came from the pre-existing wiki seed rather than
   *  a run event, so we know to preserve it across run resets. */
  fromSeed?: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  source: string;
  target: string;
}

const WIDTH = 860;
const HEIGHT = 520;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;

const QUERY_SPRING_LENGTH = 150;
const RESULT_SPRING_LENGTH = 95;
const SEED_SPRING_LENGTH = 140;

const BASE_PARAMS: Omit<SimParams, 'springLength'> = {
  width: WIDTH,
  height: HEIGHT,
  repulsion: 2800,
  spring: 0.05,
  centerGravity: 0.008,
  damping: 0.84,
};

const ROOT_PINNED = new Set(['__root__']);

/**
 * Ticks the research graph once. Spring length is chosen per-edge based on
 * the kinds of its endpoints — query hubs sit further from root than their
 * results do, so the graph reads "hub → sub-hub → leaf" at a glance.
 * Wiki-link edges between seeded sources sit in the middle so the
 * pre-existing constellation spreads out.
 */
function step(nodes: Node[], edges: Edge[], byId: Map<string, Node>): void {
  const springLength = (e: SimEdge): number => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (a && b && a.kind === 'result' && b.kind === 'result') return SEED_SPRING_LENGTH;
    if (b && b.kind === 'result') return RESULT_SPRING_LENGTH;
    return QUERY_SPRING_LENGTH;
  };
  tick(nodes, edges, { ...BASE_PARAMS, springLength }, ROOT_PINNED);
  // Root is pinned dead-center — the shared tick freezes its velocity but
  // doesn't reposition it, so keep the explicit snap here in case it ever
  // drifts (e.g. the label change handler recreating the node).
  const root = byId.get('__root__');
  if (root) {
    root.x = CENTER_X;
    root.y = CENTER_Y;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function resultColor(status: Node['status']): string {
  // Two shades of dark purple: queries are deeper, results lighter.
  // Skipped results fade out into the background.
  switch (status) {
    case 'skipped':
      return 'var(--rg-skipped, #3e3842)';
    case 'ingested':
    case 'pending':
    default:
      return 'var(--rg-result, #9a7a95)';
  }
}

// Witty rotating status phrases. {q} is replaced with the current query so
// the line feels tied to what the agent is actually doing right now.
const RESEARCH_PHRASES: string[] = [
  'rummaging through {q}',
  'opening way too many tabs about {q}',
  'chasing down {q}',
  'reading the fine print on {q}',
  'following the {q} breadcrumbs',
  'peeking under the hood of {q}',
  'asking the internet about {q}',
  'fact-checking {q}',
  'diving into {q}',
  'hunting primary sources on {q}',
  'skimming abstracts about {q}',
  'looking sideways at {q}',
  'interrogating {q}',
  'triangulating {q}',
  'double-clicking on {q}',
];

const IDLE_PHRASES: string[] = [
  'warming up the search engine',
  'sharpening the pencils',
  'cracking knuckles',
  'queueing up the next batch',
  'waiting for the planner',
];

function phraseFor(query: string | null, seed: number): string {
  const pool = query ? RESEARCH_PHRASES : IDLE_PHRASES;
  const base = pool[seed % pool.length]!;
  if (!query) return base;
  const short = query.length > 48 ? `${query.slice(0, 47)}…` : query;
  return base.replace('{q}', short);
}

interface Props {
  events: DeepPlanResearchEvent[];
  rootLabel: string;
  /** Controls whether the simulation keeps ticking even after the run ends. */
  running: boolean;
  /**
   * Optional override for ingested-node clicks. When provided, the graph
   * calls this with the slug instead of routing through the global source
   * preview popup — useful for callers that want a side-by-side pane.
   */
  onNodeOpen?: (slug: string) => void;
  /**
   * Optional pre-existing wiki to seed the graph with. When provided,
   * those sources appear as plain ingested nodes (no fresh highlight)
   * and persist across run resets; new run events layer on top.
   */
  seedGraph?: WikiGraph | null;
  /**
   * When provided and the graph is `running`, a Stop button mounts in the
   * top-right of the canvas. Callers that own the run lifecycle (e.g. the
   * Deep Search modal) pass this so the stop action lives on the graph.
   */
  onStopResearch?: () => void;
}

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.25;

// Hit radii for the transparent hover/click targets. Sized to comfortably
// contain the grown-on-hover visible circle PLUS any stroke/drop-shadow
// glow (fresh ingests), so the hit zone matches what the user actually
// sees, not the underlying 6/8-px disc.
const QUERY_HIT_R = 14;
const RESULT_HIT_R = 12;

export function ResearchGraph({
  events,
  rootLabel,
  running,
  onNodeOpen,
  seedGraph,
  onStopResearch,
}: Props): JSX.Element {
  const [, forceRender] = useState(0);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const byIdRef = useRef<Map<string, Node>>(new Map());
  const lastEventCountRef = useRef(0);
  const lastMutationRef = useRef<number>(Date.now());
  // Tracks the runId from the most recent run-start event. Only nodes
  // whose ingestion event matches this get the "fresh this run" highlight.
  const currentRunIdRef = useRef<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const openPreview = useSourcePreview((s) => s.open);

  // Zoom + pan state. viewBox is derived from these so the nodes' coordinate
  // space never changes — the sim keeps running in unscaled space.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  // Set by the drag handler when movement exceeds the click threshold; the
  // node onClick reads this to swallow the click that would otherwise fire
  // at drag-end.
  const suppressClickRef = useRef(false);

  const handleZoom = (factor: number): void => {
    setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor)));
  };
  const handleResetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Click-drag to pan. We attach window listeners imperatively on mousedown
  // so dragging off the SVG keeps working, and detach them on mouseup.
  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>): void => {
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
      const ratioX = WIDTH / currentZoom / rect.width;
      const ratioY = HEIGHT / currentZoom / rect.height;
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

  // Click handler for ingested result nodes — fetches the full SourceMeta
  // (the graph only carries slug + name) and hands it to the preview popup,
  // unless the caller wants to own the click (side-by-side pane, etc).
  const openIngestedNode = (slug: string): void => {
    if (onNodeOpen) {
      onNodeOpen(slug);
      return;
    }
    void bridge.sources.list().then((all) => {
      const full = all.find((s) => s.slug === slug);
      if (full) openPreview(full);
    });
  };

  // Seed the root node once on mount (and update its label if the task changes).
  useEffect(() => {
    const byId = byIdRef.current;
    let root = byId.get('__root__');
    if (!root) {
      root = {
        id: '__root__',
        kind: 'root',
        label: rootLabel,
        parentId: null,
        x: CENTER_X,
        y: CENTER_Y,
        vx: 0,
        vy: 0,
      };
      nodesRef.current.push(root);
      byId.set('__root__', root);
    } else {
      root.label = rootLabel;
    }
  }, [rootLabel]);

  // Pre-populate the graph with the existing wiki when a seed is provided.
  // Seeded nodes render as plain ingested sources (no fresh highlight) and
  // are marked so later run-start events don't wipe them.
  const hasSeedRef = useRef(false);
  useEffect(() => {
    if (!seedGraph) return;
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const byId = byIdRef.current;

    // Only apply a seed for slugs we don't already know about — repeat
    // effect runs (React strict mode, prop identity changes) should be
    // idempotent.
    const seedNodeCount = seedGraph.nodes.length;
    const radius = Math.min(WIDTH, HEIGHT) * 0.38;
    let added = 0;
    seedGraph.nodes.forEach((sn, i) => {
      if (byId.has(sn.id)) return;
      const angle = (2 * Math.PI * i) / Math.max(seedNodeCount, 1);
      const n: Node = {
        id: sn.id,
        kind: 'result',
        label: sn.name,
        parentId: null,
        status: 'ingested',
        slug: sn.id,
        fromSeed: true,
        freshThisRun: false,
        x: CENTER_X + Math.cos(angle) * radius + (Math.random() - 0.5) * 20,
        y: CENTER_Y + Math.sin(angle) * radius + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
      };
      nodes.push(n);
      byId.set(n.id, n);
      added++;
    });
    for (const e of seedGraph.edges) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      const exists = edges.some(
        (x) => x.source === e.source && x.target === e.target,
      );
      if (!exists) edges.push({ source: e.source, target: e.target });
    }
    hasSeedRef.current = seedGraph.nodes.length > 0;
    if (added > 0) lastMutationRef.current = Date.now();
  }, [seedGraph]);

  // Feed new events into the node/edge set.
  useEffect(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const byId = byIdRef.current;
    const start = lastEventCountRef.current;

    for (let i = start; i < events.length; i++) {
      const ev = events[i]!;
      switch (ev.kind) {
        case 'run-start': {
          currentRunIdRef.current = ev.runId;
          if (hasSeedRef.current) {
            // Seeded mode: keep the existing constellation, just demote
            // any prior-run fresh nodes to plain ingested so the new run's
            // additions are the only ones highlighted.
            for (const n of nodes) {
              if (n.freshThisRun) n.freshThisRun = false;
            }
          } else {
            // Legacy reset: wipe everything and re-seed the root only.
            nodes.length = 0;
            edges.length = 0;
            byId.clear();
            const root: Node = {
              id: '__root__',
              kind: 'root',
              label: rootLabel,
              parentId: null,
              x: CENTER_X,
              y: CENTER_Y,
              vx: 0,
              vy: 0,
            };
            nodes.push(root);
            byId.set('__root__', root);
          }
          break;
        }
        case 'query-start': {
          const n: Node = {
            id: ev.queryId,
            kind: 'query',
            label: ev.query,
            parentId: '__root__',
            x: CENTER_X + (Math.random() - 0.5) * 60,
            y: CENTER_Y + (Math.random() - 0.5) * 60,
            vx: 0,
            vy: 0,
          };
          nodes.push(n);
          byId.set(n.id, n);
          edges.push({ source: '__root__', target: n.id });
          break;
        }
        case 'result-seen': {
          const parent = byId.get(ev.queryId);
          if (!parent) break;
          const n: Node = {
            id: ev.resultId,
            kind: 'result',
            label: ev.title || ev.url,
            parentId: ev.queryId,
            status: 'pending',
            url: ev.url,
            x: parent.x + (Math.random() - 0.5) * 40,
            y: parent.y + (Math.random() - 0.5) * 40,
            vx: 0,
            vy: 0,
          };
          nodes.push(n);
          byId.set(n.id, n);
          edges.push({ source: ev.queryId, target: n.id });
          break;
        }
        case 'result-ingested': {
          const transient = byId.get(ev.resultId);
          // If the wiki already had this source (seeded), merge the
          // run's transient result into the existing seeded node rather
          // than duplicating — then mark the seeded one as fresh so the
          // user sees that THIS run surfaced it again.
          const existingBySlug = nodes.find(
            (n) => n.slug === ev.slug && n.id !== ev.resultId,
          );
          if (existingBySlug) {
            existingBySlug.freshThisRun =
              ev.runId === currentRunIdRef.current;
            if (transient) {
              const idx = nodes.indexOf(transient);
              if (idx >= 0) nodes.splice(idx, 1);
              byId.delete(transient.id);
              for (let k = edges.length - 1; k >= 0; k--) {
                const e2 = edges[k]!;
                if (e2.source === transient.id || e2.target === transient.id) {
                  edges.splice(k, 1);
                }
              }
            }
            break;
          }
          if (!transient) break;
          transient.status = 'ingested';
          transient.label = ev.name;
          transient.slug = ev.slug;
          transient.freshThisRun = ev.runId === currentRunIdRef.current;
          break;
        }
        case 'result-skipped': {
          const n = byId.get(ev.resultId);
          if (!n) break;
          n.status = 'skipped';
          n.skipReason = ev.reason;
          break;
        }
        case 'query-done':
        case 'run-done':
        case 'hint-added':
          break;
      }
    }
    lastEventCountRef.current = events.length;
    if (events.length > start) lastMutationRef.current = Date.now();
  }, [events, rootLabel]);

  // Animation loop: tick while running, and for a couple of seconds after
  // so newly added nodes have time to settle before the graph freezes.
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      const elapsedSinceMutation = Date.now() - lastMutationRef.current;
      if (running || elapsedSinceMutation < 2500) {
        step(nodesRef.current, edgesRef.current, byIdRef.current);
        forceRender((n) => n + 1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const nodes = nodesRef.current;
  const edges = edgesRef.current;
  const byId = byIdRef.current;
  const hovered = hoverId ? byId.get(hoverId) ?? null : null;

  // Track the most-recently-started query — the "what are we doing right
  // now" anchor the witty status line reads from.
  const activeQuery = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.kind === 'query-start') return ev.query;
      if (ev.kind === 'run-done') return null;
    }
    return null;
  })();

  // Rotate the witty phrase every ~3.5s so the line feels alive without
  // distracting from the graph animation.
  const [phraseSeed, setPhraseSeed] = useState(() => Math.floor(Math.random() * 1000));
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setPhraseSeed((s) => s + 1);
    }, 3500);
    return () => window.clearInterval(id);
  }, [running]);
  // Nudge the seed forward when the active query changes so the phrase
  // doesn't feel stuck on the previous subject.
  useEffect(() => {
    setPhraseSeed((s) => s + 1);
  }, [activeQuery]);

  const phrase = phraseFor(activeQuery, phraseSeed);

  // Small "queries / sources" counter pinned to the top-left of the graph.
  // Counts come straight from the event stream so it stays in sync without
  // threading status down into this component.
  let queryCount = 0;
  let sourceCount = 0;
  for (const ev of events) {
    if (ev.kind === 'query-start') queryCount++;
    else if (ev.kind === 'result-ingested') sourceCount++;
  }

  const hasGraph = nodes.length > 1;

  return (
    <div className="research-graph">
      <div className="rg-canvas">
      {running && onStopResearch && (
        <button
          type="button"
          className="rg-stop-btn"
          onClick={onStopResearch}
          title="Stop research"
        >
          Stop research
        </button>
      )}
      {hasGraph && (
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
      {(queryCount > 0 || sourceCount > 0) && (
        <div className="rg-stats" aria-hidden="true">
          <span className={`ds-dot${running ? ' ds-dot-running' : ''}`} />
          <div className="rg-stats-values">
            <div className="rg-stats-row">
              <span className="rg-stats-num">{queryCount}</span>
              <span className="rg-stats-label">queries</span>
            </div>
            <div className="rg-stats-row">
              <span className="rg-stats-num">{sourceCount}</span>
              <span className="rg-stats-label">sources</span>
            </div>
          </div>
        </div>
      )}
      {nodes.length <= 1 ? (
        <div className="research-graph-empty">
          {running
            ? 'Waiting for the first query…'
            : 'No research yet. Start a run to see the agent explore.'}
        </div>
      ) : (
        <svg
          className={`research-graph-svg${isDragging ? ' research-graph-svg-grabbing' : ''}`}
          viewBox={`${CENTER_X - WIDTH / zoom / 2 + pan.x} ${
            CENTER_Y - HEIGHT / zoom / 2 + pan.y
          } ${WIDTH / zoom} ${HEIGHT / zoom}`}
          preserveAspectRatio="xMidYMid meet"
          onMouseDown={handleSvgMouseDown}
        >
          <g>
            {edges.map((e, i) => {
              const a = byId.get(e.source);
              const b = byId.get(e.target);
              if (!a || !b) return null;
              return (
                <line
                  key={`${e.source}->${e.target}-${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="research-graph-edge"
                />
              );
            })}
          </g>
          <g>
            {nodes.map((n) => {
              const active = hoverId === n.id;
              if (n.kind === 'root') {
                return (
                  <circle
                    key={n.id}
                    cx={n.x}
                    cy={n.y}
                    r={14}
                    className="rg-root"
                  />
                );
              }
              // Hit target is a separate transparent circle with a fixed,
              // generous radius. It owns the pointer events so the visible
              // circle can grow/shrink/glow freely without the hover zone
              // changing underneath the cursor — fixes the edge-flicker bug
              // you get when the sim ticks move a node by fractions of a
              // px and the cursor keeps crossing a small visible boundary.
              // Also makes fresh nodes' drop-shadow glow clickable.
              if (n.kind === 'query') {
                return (
                  <g key={n.id}>
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={active ? 11 : 8.5}
                      className="rg-query"
                      style={{ pointerEvents: 'none' }}
                    />
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={QUERY_HIT_R}
                      className="rg-hit"
                      onMouseEnter={() => {
                        hoverRef.current = n.id;
                        setHoverId(n.id);
                      }}
                      onMouseLeave={() => {
                        hoverRef.current = null;
                        setHoverId(null);
                      }}
                    />
                  </g>
                );
              }
              const clickable = n.status === 'ingested' && !!n.slug;
              const fresh = clickable && n.freshThisRun === true;
              return (
                <g key={n.id}>
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={active ? 8 : 6}
                    fill={resultColor(n.status)}
                    className={`rg-result rg-result-${n.status ?? 'pending'}${
                      clickable ? ' rg-result-clickable' : ''
                    }${fresh ? ' rg-result-fresh' : ''}`}
                    style={{ pointerEvents: 'none' }}
                  />
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={RESULT_HIT_R}
                    className="rg-hit"
                    style={clickable ? { cursor: 'pointer' } : undefined}
                    onMouseEnter={() => {
                      hoverRef.current = n.id;
                      setHoverId(n.id);
                    }}
                    onMouseLeave={() => {
                      hoverRef.current = null;
                      setHoverId(null);
                    }}
                    onClick={(e) => {
                      if (!clickable) return;
                      if (suppressClickRef.current) return;
                      e.stopPropagation();
                      openIngestedNode(n.slug!);
                    }}
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      </div>

      <div className="research-graph-tooltip">
        {hovered ? (
          <>
            <div className="rg-tooltip-headline">
              <span className="rg-tooltip-kind">
                {hovered.kind === 'query'
                  ? 'QUERY'
                  : hovered.status === 'ingested'
                    ? 'INGESTED'
                    : hovered.status === 'skipped'
                      ? `SKIPPED (${hovered.skipReason ?? '?'})`
                      : 'CHECKING'}
              </span>
              <span className="rg-tooltip-sep">—</span>
              <span className="rg-tooltip-label">{truncate(hovered.label, 120)}</span>
            </div>
            {hovered.url && <div className="rg-tooltip-url">{hovered.url}</div>}
          </>
        ) : (
          <div className="rg-tooltip-hint">
            Hover for details · click an ingested node to open its summary.
          </div>
        )}
      </div>

      {running && (
        <div className="research-graph-status">
          <div className="rg-status-line">
            <span className="rg-status-label">Researching</span>
            <span className="generating-dots">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </span>
            <span className="rg-status-phrase">{phrase}</span>
          </div>
        </div>
      )}
    </div>
  );
}
