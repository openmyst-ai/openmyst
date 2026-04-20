import { useEffect, useMemo, useRef, useState } from 'react';
import type { WikiGraph, WikiGraphNode } from '@shared/types';
import { bridge } from '../../api/bridge';
import {
  runStatic,
  syncNodes,
  toArray,
  type SimNode,
  type SimParams,
} from '../graph/forceSim';

/**
 * Live wiki graph for the right column of Deep Plan. Re-settles when the
 * set of sources changes but preserves positions for nodes we've already
 * placed — so a fresh ingest during research doesn't snap every existing
 * node to a new spot.
 */

const WIDTH = 280;
const HEIGHT = 420;
const SETTLE_TICKS_FIRST = 320;
const SETTLE_TICKS_DELTA = 80;

const PARAMS: SimParams = {
  width: WIDTH,
  height: HEIGHT,
  repulsion: 900,
  spring: 0.04,
  springLength: 70,
  centerGravity: 0.02,
  damping: 0.82,
};

/** Visible circle stays small; hover zone is a separate generous hit target. */
const NODE_R = 4;
const NODE_R_HOVER = 6;
const HIT_R = 10;

export function WikiGraphColumn(): JSX.Element {
  const [graph, setGraph] = useState<WikiGraph | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const positionsRef = useRef<Map<string, SimNode>>(new Map());

  useEffect(() => {
    const load = (): void => {
      bridge.wiki.graph().then(setGraph).catch(console.error);
    };
    load();
    const off = bridge.sources.onChanged(load);
    return off;
  }, []);

  // Top up positions for new nodes, drop stale ones, then settle. First
  // full layout runs a long pass; incremental updates run a short one so
  // new nodes find a spot without disturbing the existing constellation.
  const simNodes = useMemo<SimNode[]>(() => {
    if (!graph) return [];
    const nodeIds = graph.nodes.map((n) => n.id);
    const positions = positionsRef.current;
    const isFirst = positions.size === 0;
    const added = syncNodes(positions, nodeIds, PARAMS, { jitter: 6 });

    if (isFirst) {
      runStatic(
        Array.from(positions.values()),
        graph.edges,
        PARAMS,
        SETTLE_TICKS_FIRST,
      );
    } else if (added > 0) {
      runStatic(
        Array.from(positions.values()),
        graph.edges,
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
              {simNodes.map((n) => {
                const active = hoverId === n.id;
                return (
                  <g key={n.id}>
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={active ? NODE_R_HOVER : NODE_R}
                      className="dp-graph-node"
                      style={{ pointerEvents: 'none' }}
                    />
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={HIT_R}
                      className="dp-graph-hit"
                      onMouseEnter={() => setHoverId(n.id)}
                      onMouseLeave={() => setHoverId(null)}
                    />
                  </g>
                );
              })}
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
