import { useEffect, useMemo, useState } from 'react';
import type { SourceMeta, WikiGraph, WikiGraphNode } from '@shared/types';
import { bridge } from '../api/bridge';
import { renderMarkdown } from '../utils/markdown';

/**
 * Deep Wiki — an Obsidian-style map of the research wiki. Lives next to Deep
 * Search in the titlebar and uses the same side-by-side modal pattern: the
 * graph renders on the left, and clicking a node slides in a preview pane
 * with that source's full summary. The two lines at the top are the user's
 * mental model: this graph is what the LLM traverses on every turn to pull
 * anchored information, so keeping sources well-summarised and linked is
 * what makes the agent's citations sharp.
 */

interface SimNode extends WikiGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface SimEdge {
  source: string;
  target: string;
}

const WIDTH = 820;
const HEIGHT = 520;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const SIM_TICKS = 520;
const REPULSION = 5200;
const SPRING = 0.03;
const SPRING_LENGTH = 190;
const CENTER_GRAVITY = 0.009;
const DAMPING = 0.84;

function runSimulation(nodes: SimNode[], edges: SimEdge[]): void {
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
  const radius = Math.min(WIDTH, HEIGHT) * 0.35;
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

export function DeepWikiModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState<SourceMeta | null>(null);

  useEffect(() => {
    bridge.wiki.graph().then(setGraph).catch(console.error);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const simNodes = useMemo<SimNode[]>(() => {
    if (!graph) return [];
    const nodes = seedNodes(graph);
    runSimulation(nodes, graph.edges);
    return nodes;
  }, [graph]);

  const nodeById = useMemo(() => new Map(simNodes.map((n) => [n.id, n])), [simNodes]);
  const hovered = hoverId ? nodeById.get(hoverId) ?? null : null;

  const sourceCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;

  const handleNodeClick = (id: string): void => {
    void bridge.sources.list().then((all) => {
      const full = all.find((s) => s.slug === id);
      if (full) setPreviewSource(full);
    });
  };

  const previewHtml = useMemo(
    () => (previewSource ? renderMarkdown(previewSource.summary) : ''),
    [previewSource],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal ds-modal${previewSource ? ' ds-modal-with-preview' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-modal-main">
          <header className="modal-header">
            <div>
              <h2>Deep Wiki</h2>
              <p className="muted ds-modal-sub">
                Links between your sources' summaries and the anchored facts
                inside them. Every prompt, your LLM explores this graph and
                jumps to nodes to pull anchored information — so the richer
                the wiki, the sharper its citations.
              </p>
            </div>
            <button type="button" className="titlebar-btn" onClick={onClose}>
              Close
            </button>
          </header>

          <section className="modal-section">
            <div className="ds-modal-stats muted">
              {sourceCount} source{sourceCount === 1 ? '' : 's'} · {edgeCount} link
              {edgeCount === 1 ? '' : 's'}
            </div>

            <div className="wiki-graph-canvas-wrap">
              {!graph && <div className="wiki-graph-empty">Loading…</div>}
              {graph && sourceCount === 0 && (
                <div className="wiki-graph-empty">
                  No sources yet. Drop some into the Sources panel and the agent
                  will start weaving them together here.
                </div>
              )}
              {graph && sourceCount > 0 && (
                <svg
                  className="wiki-graph-svg"
                  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  <g>
                    {graph.edges.map((e, i) => {
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
                      const active = hoverId === n.id || previewSource?.slug === n.id;
                      return (
                        <g
                          key={n.id}
                          className="wiki-graph-node-g"
                          onMouseEnter={() => setHoverId(n.id)}
                          onMouseLeave={() => setHoverId(null)}
                          onClick={() => handleNodeClick(n.id)}
                        >
                          <circle
                            cx={n.x}
                            cy={n.y}
                            r={active ? 9 : 7}
                            className={active ? 'wiki-graph-node wiki-graph-node-active' : 'wiki-graph-node'}
                          />
                          <text
                            x={n.x}
                            y={n.y + 20}
                            textAnchor="middle"
                            className="wiki-graph-label"
                          >
                            {n.name.length > 22 ? `${n.name.slice(0, 20)}…` : n.name}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                </svg>
              )}
            </div>

            <div className="wiki-graph-tooltip">
              {hovered ? (
                <>
                  <div className="wiki-graph-tooltip-name">{hovered.name}</div>
                  <div className="wiki-graph-tooltip-summary">{hovered.indexSummary}</div>
                </>
              ) : (
                <div className="wiki-graph-tooltip-hint">
                  Hover a node to peek its summary · click to open the full source.
                </div>
              )}
            </div>
          </section>
        </div>

        {previewSource && (
          <aside className="ds-modal-preview">
            <div className="ds-modal-preview-header">
              <h3>{previewSource.name}</h3>
              <button
                type="button"
                className="source-preview-close"
                onClick={() => setPreviewSource(null)}
                aria-label="Close preview"
              >
                &#x2715;
              </button>
            </div>
            <div
              className="ds-modal-preview-body dp-md"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
            {previewSource.sourcePath && (
              <div className="ds-modal-preview-path">{previewSource.sourcePath}</div>
            )}
            {!previewSource.sourcePath && previewSource.type === 'pasted' && (
              <div className="ds-modal-preview-path">Pasted text</div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
