import { useEffect, useMemo, useState } from 'react';
import type { WikiGraph as WikiGraphData } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useResearchEvents } from '../../store/researchEvents';
import { useDeepPlan } from '../../store/deepPlan';
import { useSourcePreview } from '../../store/sourcePreview';
import { WikiGraph, freshSlugsFromEvents } from '../graph/WikiGraph';
import {
  latestQueryText,
  researchRunningFromEvents,
  useQueryFlash,
} from '../../hooks/useResearchFlash';

/**
 * Deep Plan's right column. The wiki graph is visible across every phase
 * now — the panel can dispatch research in any phase, so users always
 * want the live map of their knowledge graph to the right of the
 * conversation. "Fresh" slugs (ingested in the current run) glow while
 * a round is executing. When the engine is actively searching, a
 * floating pill pins to the top of the graph with the live query text so
 * the user never has to guess whether anything is happening.
 */

export function WikiGraphColumn(): JSX.Element {
  const [graph, setGraph] = useState<WikiGraphData | null>(null);
  const researchEvents = useResearchEvents((s) => s.events);
  const openPreview = useSourcePreview((s) => s.open);
  const roundRunning = useDeepPlan((s) => s.status?.roundRunning ?? false);

  useEffect(() => {
    const load = (): void => {
      bridge.wiki.graph().then(setGraph).catch(console.error);
    };
    load();
    const off = bridge.sources.onChanged(load);
    return off;
  }, []);

  const freshSlugs = useMemo(
    () => freshSlugsFromEvents(researchEvents),
    [researchEvents],
  );

  const searching = useMemo(
    () => researchRunningFromEvents(researchEvents),
    [researchEvents],
  );
  const currentQuery = useMemo(
    () => latestQueryText(researchEvents),
    [researchEvents],
  );
  const flashQuery = useQueryFlash(currentQuery);

  const handleNodeOpen = (slug: string): void => {
    void bridge.sources.list().then((all) => {
      const full = all.find((s) => s.slug === slug);
      if (full) openPreview(full);
    });
  };

  return (
    <div className="dp-graph dp-graph-fullbleed">
      {searching && (
        <div
          className={`dp-research-thinking${
            flashQuery ? ' dp-research-thinking-flashing' : ''
          }`}
          role="status"
          aria-live="polite"
        >
          <span className="generating-dots">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </span>
          <span className="dp-research-thinking-label">Researching the web</span>
          <span
            className={`dp-research-thinking-query${
              flashQuery ? ' dp-research-thinking-query-open' : ''
            }`}
          >
            {flashQuery ?? ''}
          </span>
        </div>
      )}
      <WikiGraph
        graph={graph}
        freshSlugs={freshSlugs}
        running={roundRunning}
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
