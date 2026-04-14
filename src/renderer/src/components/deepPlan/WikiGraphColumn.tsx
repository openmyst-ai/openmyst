import { useEffect, useMemo, useState } from 'react';
import type { WikiGraph, WikiGraphNode } from '@shared/types';
import { bridge } from '../../api/bridge';

/**
 * Live wiki graph for the right column of Deep Plan. Re-runs the simulation
 * whenever sources change (new research loop ingests or user-added sources).
 * Force sim is identical in spirit to WikiGraphModal but scaled to the
 * narrower column and tuned to animate subtly rather than freezing.
 */

interface SimNode extends WikiGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const WIDTH = 280;
const HEIGHT = 420;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const SIM_TICKS = 320;
const REPULSION = 900;
const SPRING = 0.04;
const SPRING_LENGTH = 70;
const CENTER_GRAVITY = 0.02;
const DAMPING = 0.82;

function runSimulation(nodes: SimNode[], edges: WikiGraph['edges']): void {
  if (nodes.length === 0) return;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let tick = 0; tick < SIM_TICKS; tick++) {
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
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const delta = dist - SPRING_LENGTH;
      const fx = (dx / dist) * delta * SPRING;
      const fy = (dy / dist) * delta * SPRING;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const n of nodes) {
      n.vx += (CENTER_X - n.x) * CENTER_GRAVITY;
      n.vy += (CENTER_Y - n.y) * CENTER_GRAVITY;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    }
  }
}

function seedNodes(graph: WikiGraph): SimNode[] {
  const n = graph.nodes.length;
  if (n === 0) return [];
  const radius = Math.min(WIDTH, HEIGHT) * 0.3;
  return graph.nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1);
    return {
      ...node,
      x: CENTER_X + Math.cos(angle) * radius,
      y: CENTER_Y + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });
}

export function WikiGraphColumn(): JSX.Element {
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    const load = (): void => {
      bridge.wiki.graph().then(setGraph).catch(console.error);
    };
    load();
    const off = bridge.sources.onChanged(load);
    return off;
  }, []);

  const simNodes = useMemo<SimNode[]>(() => {
    if (!graph) return [];
    const nodes = seedNodes(graph);
    runSimulation(nodes, graph.edges);
    return nodes;
  }, [graph]);

  const nodeById = useMemo(() => new Map(simNodes.map((n) => [n.id, n])), [simNodes]);
  const hovered = hoverId ? nodeById.get(hoverId) ?? null : null;

  return (
    <div className="dp-graph">
      <div className="dp-col-header">
        <h3>Wiki graph</h3>
        <span className="dp-muted">
          {graph?.nodes.length ?? 0} · {graph?.edges.length ?? 0}
        </span>
      </div>

      <div className="dp-graph-wrap">
        {!graph || graph.nodes.length === 0 ? (
          <div className="dp-empty dp-graph-empty">
            As sources land, you'll watch them wire themselves together here.
          </div>
        ) : (
          <svg
            className="dp-graph-svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <g>
              {graph.edges.map((e, i) => {
                const a = nodeById.get(e.source);
                const b = nodeById.get(e.target);
                if (!a || !b) return null;
                return (
                  <line
                    key={`${e.source}->${e.target}-${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className="dp-graph-edge"
                  />
                );
              })}
            </g>
            <g>
              {simNodes.map((n) => (
                <g
                  key={n.id}
                  onMouseEnter={() => setHoverId(n.id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={hoverId === n.id ? 6 : 4}
                    className="dp-graph-node"
                  />
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>

      <div className="dp-graph-tooltip">
        {hovered ? (
          <>
            <div className="dp-graph-tooltip-name">{hovered.name}</div>
            <div className="dp-graph-tooltip-summary">{hovered.indexSummary}</div>
          </>
        ) : (
          <div className="dp-muted">Hover a node to peek at its summary.</div>
        )}
      </div>
    </div>
  );
}
