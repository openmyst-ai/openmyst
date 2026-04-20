import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SourceMeta, WikiGraph as WikiGraphData } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useDeepSearch } from '../../store/deepSearch';
import { useResearchEvents } from '../../store/researchEvents';
import { renderMarkdown } from '../../utils/markdown';
import { WikiGraph, freshSlugsFromEvents } from '../graph/WikiGraph';

/**
 * Deep Wiki — the unified surface for browsing and extending the project's
 * research wiki. Entry point is the search box: typing a task kicks off a
 * research run, and whatever the agent ingests lands on the graph as new
 * source nodes (no query/root hubs — those were clutter). Well-connected
 * sources render visibly larger via sqrt-of-degree sizing so "impactful"
 * nodes pop without tooltips.
 *
 * Previously two separate surfaces:
 *   - Deep Search (query-and-result subgraph, modal)
 *   - Deep Wiki   (static graph of all sources, separate modal)
 * Collapsed into one because they were showing the same underlying graph
 * through different lenses — and a graph whose only nodes are sources is
 * the lens that actually matters.
 *
 * Lifecycle:
 *   - open → refresh status so we see if there's already a run in flight
 *   - subscribe to deepSearch.onChanged (state) + deepPlan.onResearchEvent
 *     (graph events, used only for the "fresh this run" highlight) +
 *     sources.onChanged (to pull new wiki snapshots when a source is ingested)
 *   - close on ESC / backdrop click
 */

export function DeepSearchModal(): JSX.Element | null {
  const { visible, status, error, close, refresh, start, stop, reset, addHint, clearError } =
    useDeepSearch();
  const pushResearchEvent = useResearchEvents((s) => s.push);
  const resetResearchEvents = useResearchEvents((s) => s.reset);
  const researchEvents = useResearchEvents((s) => s.events);

  const [taskDraft, setTaskDraft] = useState('');
  const [hintDraft, setHintDraft] = useState('');
  const [previewSource, setPreviewSource] = useState<SourceMeta | null>(null);
  const [graph, setGraph] = useState<WikiGraphData | null>(null);

  // Pull (and re-pull) the live wiki snapshot — refetched on source
  // changes so an ingest during a run shows up on the graph immediately.
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const load = (): void => {
      bridge.wiki.graph().then(setGraph).catch(console.error);
    };
    load();
    const offSources = bridge.sources.onChanged(load);
    const offChanged = bridge.deepSearch.onChanged(() => {
      void refresh();
    });
    const offEvent = bridge.deepPlan.onResearchEvent(pushResearchEvent);
    return () => {
      offSources();
      offChanged();
      offEvent();
    };
  }, [visible, refresh, pushResearchEvent]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, close]);

  const handleStart = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = taskDraft.trim();
      if (!text) return;
      await start(text);
    },
    [taskDraft, start],
  );

  const handleAddHint = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = hintDraft.trim();
      if (!text) return;
      setHintDraft('');
      await addHint(text);
    },
    [hintDraft, addHint],
  );

  const handleNodeOpen = useCallback((slug: string) => {
    void bridge.sources.list().then((all) => {
      const full = all.find((s) => s.slug === slug);
      if (full) setPreviewSource(full);
    });
  }, []);

  const previewHtml = useMemo(
    () => (previewSource ? renderMarkdown(previewSource.summary) : ''),
    [previewSource],
  );

  const freshSlugs = useMemo(() => freshSlugsFromEvents(researchEvents), [researchEvents]);
  const currentQuery = useMemo(() => latestQueryText(researchEvents), [researchEvents]);

  useEffect(() => {
    if (!visible) {
      setPreviewSource(null);
      setGraph(null);
    }
  }, [visible]);

  if (!visible) return null;

  const running = status?.running ?? false;
  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className={`modal ds-modal${previewSource ? ' ds-modal-with-preview' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-modal-main">
          <header className="modal-header">
            <div>
              <h2>Deep Wiki</h2>
              <p className="muted ds-modal-sub">
                Your project's research graph. Search to send the agent hunting,
                whatever it ingests lands here and links up with what's already
                in the wiki.
              </p>
            </div>
            <button type="button" className="titlebar-btn" onClick={close}>
              Close
            </button>
          </header>

          {error && (
            <div className="error">
              <span>{error}</span>
              <button type="button" className="link" onClick={clearError}>
                Dismiss
              </button>
            </div>
          )}

          <section className="modal-section ds-search-section">
            <form className="ds-start-form" onSubmit={(e) => void handleStart(e)}>
              <input
                autoFocus={!running && !status?.task}
                type="text"
                className="ds-start-input"
                placeholder={
                  running
                    ? 'Research is running…'
                    : status?.task
                      ? 'Start another search…'
                      : 'Search the wiki — or send the agent to grow it'
                }
                value={taskDraft}
                onChange={(e) => setTaskDraft(e.target.value)}
                disabled={running}
              />
              <button
                type="submit"
                className="dp-btn dp-btn-primary dp-btn-small"
                disabled={taskDraft.trim().length === 0 || running}
              >
                Search
              </button>
              {running && (
                <button
                  type="button"
                  className="dp-btn dp-btn-secondary dp-btn-small"
                  onClick={() => void stop()}
                >
                  Stop
                </button>
              )}
              {!running && status?.task && (
                <button
                  type="button"
                  className="dp-btn dp-btn-secondary dp-btn-small"
                  onClick={() => {
                    setTaskDraft('');
                    resetResearchEvents();
                    void reset();
                  }}
                >
                  Reset
                </button>
              )}
            </form>
            {status?.task && (
              <div className="ds-task-row ds-task-row-compact">
                <span className={`ds-dot${running ? ' ds-dot-running' : ''}`} />
                <span className="muted">{running ? 'Researching' : 'Last run'} ·</span>
                <span className="ds-task-text">{status.task}</span>
              </div>
            )}
          </section>

          <section className="modal-section ds-graph-section">
            <div className="ds-modal-stats muted">
              {nodeCount} source{nodeCount === 1 ? '' : 's'} · {edgeCount} link
              {edgeCount === 1 ? '' : 's'}
              {freshSlugs.size > 0 && ` · ${freshSlugs.size} new this run`}
            </div>
            <div className="ds-graph-wrap">
              {running && (
                <div className="dp-research-thinking">
                  <span className="generating-dots">
                    <span className="dot" />
                    <span className="dot" />
                    <span className="dot" />
                  </span>
                  <span className="dp-research-thinking-label">
                    Researching
                    {currentQuery ? (
                      <> <span className="dp-research-thinking-query">{currentQuery}</span></>
                    ) : (
                      '…'
                    )}
                  </span>
                </div>
              )}
              <WikiGraph
                graph={graph}
                freshSlugs={freshSlugs}
                running={running}
                onNodeOpen={handleNodeOpen}
                selectedSlug={previewSource?.slug ?? null}
              />
            </div>
          </section>

          {running && (
            <section className="modal-section">
              <form className="dp-hint-form" onSubmit={(e) => void handleAddHint(e)}>
                <input
                  className="dp-hint-input"
                  placeholder="Steer research…"
                  value={hintDraft}
                  onChange={(e) => setHintDraft(e.target.value)}
                />
                <button
                  type="submit"
                  className="dp-btn dp-btn-secondary dp-btn-small"
                  disabled={hintDraft.trim().length === 0}
                >
                  Add hint
                </button>
              </form>
              {status?.hints && status.hints.length > 0 && (
                <div className="ds-hints-list">
                  {status.hints.map((h, i) => (
                    <div key={i} className="ds-hint-chip">
                      {h}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {status && status.queries.length > 0 && (
            <section className="modal-section ds-queries-section">
              <h3>Queries tried · {status.queries.length}</h3>
              <p className="muted">
                Previous searches against your wiki. Helpful context for the next run so the model
                (and you) don't repeat ground.
              </p>
              <ul className="ds-query-list">
                {status.queries.map((q) => (
                  <li key={q.queryId} className="ds-query-item">
                    <div className="ds-query-text">{q.query}</div>
                    {q.rationale && <div className="ds-query-rationale muted">{q.rationale}</div>}
                    <div className="ds-query-meta muted">{q.ingestedCount} ingested</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
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

function latestQueryText(
  events: Array<{ kind: string; runId?: string; query?: string }>,
): string | null {
  // Newest-first walk within the current run, so the banner flips to the
  // latest query text the instant the engine fires one. Bails on
  // run-start so text from a previous run can't leak through.
  let runId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (!runId && ev.runId) runId = ev.runId;
    if (ev.kind === 'run-start') return null;
    if (ev.runId !== runId) break;
    if (ev.kind === 'query-start' && typeof ev.query === 'string') {
      return ev.query;
    }
  }
  return null;
}
