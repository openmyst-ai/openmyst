import { useEffect, useRef, useState } from 'react';
import type { DeepPlanResearchEvent } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useSourcePreview } from '../../store/sourcePreview';

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
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  source: string;
  target: string;
}

const WIDTH = 720;
const HEIGHT = 420;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;

const REPULSION = 1400;
const SPRING = 0.06;
const QUERY_SPRING_LENGTH = 120;
const RESULT_SPRING_LENGTH = 70;
const CENTER_GRAVITY = 0.01;
const DAMPING = 0.82;

function step(nodes: Node[], edges: Edge[], byId: Map<string, Node>): void {
  // Repulsion
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy || 0.01;
      const dist = Math.sqrt(distSq);
      const force = REPULSION / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // Springs — query edges are longer than result edges so the graph reads
  // "hub → sub-hub → leaf" at a glance.
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const target = b.kind === 'result' ? RESULT_SPRING_LENGTH : QUERY_SPRING_LENGTH;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const delta = dist - target;
    const fx = (dx / dist) * delta * SPRING;
    const fy = (dy / dist) * delta * SPRING;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const n of nodes) {
    if (n.kind === 'root') {
      // Root is pinned.
      n.vx = 0;
      n.vy = 0;
      n.x = CENTER_X;
      n.y = CENTER_Y;
      continue;
    }
    n.vx += (CENTER_X - n.x) * CENTER_GRAVITY;
    n.vy += (CENTER_Y - n.y) * CENTER_GRAVITY;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function resultColor(status: Node['status']): string {
  // Two-colour scheme: queries are green, results (whether we're still
  // checking or already ingested) are blue. Skipped results fade out.
  switch (status) {
    case 'skipped':
      return 'var(--rg-skipped, #525252)';
    case 'ingested':
    case 'pending':
    default:
      return 'var(--rg-result, #60a5fa)';
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
}

export function ResearchGraph({ events, rootLabel, running }: Props): JSX.Element {
  const [, forceRender] = useState(0);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const byIdRef = useRef<Map<string, Node>>(new Map());
  const lastEventCountRef = useRef(0);
  const lastMutationRef = useRef<number>(Date.now());
  const hoverRef = useRef<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const openPreview = useSourcePreview((s) => s.open);

  // Click handler for ingested result nodes — fetches the full SourceMeta
  // (the graph only carries slug + name) and hands it to the preview popup.
  const openIngestedNode = (slug: string): void => {
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
          // Reset the graph when a new run starts.
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
          const n = byId.get(ev.resultId);
          if (!n) break;
          n.status = 'ingested';
          n.label = ev.name;
          n.slug = ev.slug;
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

  return (
    <div className="research-graph">
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
          <div className="rg-status-sub">This can take a few minutes — keep writing, I'll come find you.</div>
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
          className="research-graph-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
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
                  <g key={n.id}>
                    <circle cx={n.x} cy={n.y} r={14} className="rg-root" />
                  </g>
                );
              }
              if (n.kind === 'query') {
                return (
                  <g
                    key={n.id}
                    onMouseEnter={() => {
                      hoverRef.current = n.id;
                      setHoverId(n.id);
                    }}
                    onMouseLeave={() => {
                      hoverRef.current = null;
                      setHoverId(null);
                    }}
                  >
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={active ? 9 : 7}
                      className="rg-query"
                    />
                    {active && (
                      <text
                        x={n.x}
                        y={n.y - 14}
                        textAnchor="middle"
                        className="rg-label rg-label-hover"
                      >
                        {truncate(n.label, 30)}
                      </text>
                    )}
                  </g>
                );
              }
              const clickable = n.status === 'ingested' && !!n.slug;
              return (
                <g
                  key={n.id}
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
                    e.stopPropagation();
                    openIngestedNode(n.slug!);
                  }}
                  style={clickable ? { cursor: 'pointer' } : undefined}
                >
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={active ? 6 : 4.5}
                    fill={resultColor(n.status)}
                    className={`rg-result rg-result-${n.status ?? 'pending'}${
                      clickable ? ' rg-result-clickable' : ''
                    }`}
                  />
                  {active && (
                    <text
                      x={n.x}
                      y={n.y - 9}
                      textAnchor="middle"
                      className="rg-label rg-label-hover"
                    >
                      {truncate(n.label, 30)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}

      <div className="research-graph-tooltip">
        {hovered ? (
          <>
            <div className="rg-tooltip-kind">
              {hovered.kind === 'query'
                ? 'Query'
                : hovered.status === 'ingested'
                  ? 'Ingested'
                  : hovered.status === 'skipped'
                    ? `Skipped (${hovered.skipReason ?? '?'})`
                    : 'Checking'}
            </div>
            <div className="rg-tooltip-label">{truncate(hovered.label, 140)}</div>
            {hovered.url && <div className="rg-tooltip-url">{hovered.url}</div>}
          </>
        ) : (
          <div className="rg-tooltip-hint">
            Hover for details · click an ingested node to open its summary.
          </div>
        )}
      </div>
    </div>
  );
}
