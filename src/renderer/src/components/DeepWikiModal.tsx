import { useEffect, useMemo, useRef, useState } from 'react';
import type { SourceMeta, WikiGraph, WikiGraphNode } from '@shared/types';
import { bridge } from '../api/bridge';
import { renderMarkdown } from '../utils/markdown';
import {
  runStatic,
  syncNodes,
  toArray,
  type SimEdge,
  type SimNode,
  type SimParams,
} from './graph/forceSim';

/**
 * Deep Wiki — an Obsidian-style map of the research wiki. Lives next to Deep
 * Search in the titlebar and uses the same side-by-side modal pattern: the
 * graph renders on the left, and clicking a node slides in a preview pane
 * with that source's full summary. The two lines at the top are the user's
 * mental model: this graph is what the LLM traverses on every turn to pull
 * anchored information, so keeping sources well-summarised and linked is
 * what makes the agent's citations sharp.
 */

const WIDTH = 820;
const HEIGHT = 520;
const SETTLE_TICKS_FIRST = 520;
const SETTLE_TICKS_DELTA = 120;

const PARAMS: SimParams = {
  width: WIDTH,
  height: HEIGHT,
  repulsion: 5200,
  spring: 0.03,
  springLength: 190,
  centerGravity: 0.009,
  damping: 0.84,
};

const NODE_R = 7;
const NODE_R_HOVER = 9;
const HIT_R = 14;

export function DeepWikiModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState<SourceMeta | null>(null);
  const positionsRef = useRef<Map<string, SimNode>>(new Map());

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

  // Preserve positions across graph refetches — only newly-added nodes
  // get seeded and only a short re-settle runs when new ones appear.
  const simNodes = useMemo<SimNode[]>(() => {
    if (!graph) return [];
    const nodeIds = graph.nodes.map((n) => n.id);
    const positions = positionsRef.current;
    const isFirst = positions.size === 0;
    const added = syncNodes(positions, nodeIds, PARAMS, { jitter: 10 });
    const edges: SimEdge[] = graph.edges;

    if (isFirst) {
      runStatic(
        Array.from(positions.values()),
        edges,
        PARAMS,
        SETTLE_TICKS_FIRST,
      );
    } else if (added > 0) {
      runStatic(
        Array.from(positions.values()),
        edges,
        PARAMS,
        SETTLE_TICKS_DELTA,
      );
    }
    return toArray(positions, nodeIds);
  }, [graph]);

  const nodeById = useMemo(() => {
    const m = new Map<string, SimNode & WikiGraphNode>();
    if (!graph) return m;
    const posById = new Map(simNodes.map((n) => [n.id, n]));
    for (const meta of graph.nodes) {
      const pos = posById.get(meta.id);
      if (pos) m.set(meta.id, { ...meta, ...pos });
    }
    return m;
  }, [graph, simNodes]);
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
                      const meta = nodeById.get(n.id);
                      if (!meta) return null;
                      const active = hoverId === n.id || previewSource?.slug === n.id;
                      return (
                        <g key={n.id} className="wiki-graph-node-g">
                          <circle
                            cx={n.x}
                            cy={n.y}
                            r={active ? NODE_R_HOVER : NODE_R}
                            className={active ? 'wiki-graph-node wiki-graph-node-active' : 'wiki-graph-node'}
                            style={{ pointerEvents: 'none' }}
                          />
                          <text
                            x={n.x}
                            y={n.y + 20}
                            textAnchor="middle"
                            className="wiki-graph-label"
                            style={{ pointerEvents: 'none' }}
                          >
                            {meta.name.length > 22 ? `${meta.name.slice(0, 20)}…` : meta.name}
                          </text>
                          <circle
                            cx={n.x}
                            cy={n.y}
                            r={HIT_R}
                            className="wiki-graph-hit"
                            onMouseEnter={() => setHoverId(n.id)}
                            onMouseLeave={() => setHoverId(null)}
                            onClick={() => handleNodeClick(n.id)}
                          />
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
