import { useEffect, useMemo, useState } from 'react';
import type { WikiGraph as WikiGraphData, DeepPlanResearchEvent } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useResearchEvents } from '../../store/researchEvents';
import { useDeepPlan } from '../../store/deepPlan';
import { useSourcePreview } from '../../store/sourcePreview';
import { WikiGraph, freshSlugsFromEvents } from '../graph/WikiGraph';

/**
 * Deep Plan's right column. Two modes:
 *   - Non-research stages → the wiki graph fills the column, full-bleed.
 *   - Research stage → the graph moves to the center column (next to the
 *     steer input), and this column becomes a live query log showing each
 *     planner query alongside the rationale the LLM gave for running it.
 *
 * The log scopes to the current run (via runId) so a new run wipes the
 * list instead of leaking queries from the previous exploration.
 */

export function WikiGraphColumn(): JSX.Element {
  const [graph, setGraph] = useState<WikiGraphData | null>(null);
  const researchEvents = useResearchEvents((s) => s.events);
  const openPreview = useSourcePreview((s) => s.open);
  const status = useDeepPlan((s) => s.status);

  const session = status?.session;
  const stage = session?.stage;
  const researchRunning = status?.researchRunning ?? false;
  const isResearchStage = stage === 'research';

  useEffect(() => {
    if (isResearchStage) return;
    const load = (): void => {
      bridge.wiki.graph().then(setGraph).catch(console.error);
    };
    load();
    const off = bridge.sources.onChanged(load);
    return off;
  }, [isResearchStage]);

  const freshSlugs = useMemo(
    () => freshSlugsFromEvents(researchEvents),
    [researchEvents],
  );

  const runQueries = useMemo(
    () => queriesForCurrentRun(researchEvents),
    [researchEvents],
  );

  const handleNodeOpen = (slug: string): void => {
    void bridge.sources.list().then((all) => {
      const full = all.find((s) => s.slug === slug);
      if (full) openPreview(full);
    });
  };

  if (isResearchStage) {
    return (
      <div className="dp-query-log">
        <div className="dp-query-log-header">
          <span className={`ds-dot${researchRunning ? ' ds-dot-running' : ''}`} />
          <span>Queries</span>
          <span className="dp-query-log-count">{runQueries.length}</span>
        </div>
        <div className="dp-query-log-scroll">
          {runQueries.length === 0 ? (
            <div className="dp-query-log-empty">
              Waiting for the first query…
            </div>
          ) : (
            <ul className="dp-query-log-list">
              {runQueries.map((q) => (
                <li key={q.queryId} className="dp-query-log-item">
                  <div className="dp-query-log-query">
                    <span className="dp-query-log-prefix">Search:</span> {q.query}
                  </div>
                  {q.rationale && (
                    <div className="dp-query-log-rationale">{q.rationale}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="dp-graph dp-graph-fullbleed">
      <WikiGraph
        graph={graph}
        freshSlugs={freshSlugs}
        running={researchRunning}
        onNodeOpen={handleNodeOpen}
        fillContainer
        hideTooltip
        showLabels={false}
        enableZoom={false}
        baseRadius={3.5}
        radiusPerEdge={1.2}
        hitRadiusPad={6}
      />
    </div>
  );
}

function queriesForCurrentRun(
  events: DeepPlanResearchEvent[],
): Array<{ queryId: string; query: string; rationale: string }> {
  // Walk backwards to find the most recent run, then collect its queries
  // forward so the newest query ends up at the bottom of the list.
  let runId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === 'run-start') {
      runId = ev.runId;
      break;
    }
    if ('runId' in ev && ev.runId) {
      runId = ev.runId;
      break;
    }
  }
  if (!runId) return [];
  const out: Array<{ queryId: string; query: string; rationale: string }> = [];
  for (const ev of events) {
    if (ev.kind !== 'query-start') continue;
    if (ev.runId !== runId) continue;
    out.push({ queryId: ev.queryId, query: ev.query, rationale: ev.rationale });
  }
  return out;
}
