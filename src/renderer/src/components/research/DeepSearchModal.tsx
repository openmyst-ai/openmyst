import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SourceMeta, WikiGraph } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useDeepSearch } from '../../store/deepSearch';
import { useResearchEvents } from '../../store/researchEvents';
import { renderMarkdown } from '../../utils/markdown';
import { ResearchGraph } from './ResearchGraph';

/**
 * Deep Search modal — the research-only slice. Opens from the editor
 * toolbar so the user can fire off a research run without leaving what
 * they're writing. Everything it finds lands in the project wiki, which
 * is exactly the same pool the main chat reads from.
 *
 * Lifecycle:
 *   - open → refresh status so we see if there's already a run in flight
 *   - subscribe to deepSearch.onChanged (state mutations) and
 *     deepPlan.onResearchEvent (graph events)
 *   - close on ESC / backdrop click
 */

export function DeepSearchModal(): JSX.Element | null {
  const { visible, status, error, close, refresh, start, stop, addHint, clearError } =
    useDeepSearch();
  const pushResearchEvent = useResearchEvents((s) => s.push);
  const researchEvents = useResearchEvents((s) => s.events);

  const [taskDraft, setTaskDraft] = useState('');
  const [hintDraft, setHintDraft] = useState('');
  // Side-by-side preview: while the modal is open, clicking an ingested
  // node shifts the content left and mounts the source summary here
  // instead of triggering the global preview popup.
  const [previewSource, setPreviewSource] = useState<SourceMeta | null>(null);
  // Wiki snapshot used to seed the graph so the user starts with the
  // existing constellation instead of an empty canvas.
  const [wikiSeed, setWikiSeed] = useState<WikiGraph | null>(null);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    // Snapshot the existing wiki so the graph can start with the full
    // constellation already in place.
    bridge.wiki.graph().then(setWikiSeed).catch(console.error);
    const offChanged = bridge.deepSearch.onChanged(() => {
      void refresh();
    });
    const offEvent = bridge.deepPlan.onResearchEvent(pushResearchEvent);
    return () => {
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

  // Drop the side pane and seed whenever the modal closes so reopening
  // pulls a fresh wiki snapshot and clears any stale preview.
  useEffect(() => {
    if (!visible) {
      setPreviewSource(null);
      setWikiSeed(null);
    }
  }, [visible]);

  if (!visible) return null;

  const running = status?.running ?? false;
  const rootLabel = status?.task ?? (taskDraft || 'Deep Search');

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className={`modal ds-modal${previewSource ? ' ds-modal-with-preview' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-modal-main">
        <header className="modal-header">
          <div>
            <h2>Deep Search</h2>
            <p className="muted ds-modal-sub">
              Run autonomous research against your wiki without touching what
              you're writing. Sources land in the project wiki for the main
              chat to pick up.
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

        {(running || status?.task) && (
          <section className="modal-section">
            <div className="ds-task-row">
              <div>
                <div className="ds-task-label">Researching</div>
                <div className="ds-task-text">{status?.task}</div>
              </div>
            </div>
          </section>
        )}

        <section className="modal-section ds-graph-section">
          <ResearchGraph
            events={researchEvents}
            rootLabel={rootLabel}
            running={running}
            onNodeOpen={handleNodeOpen}
            seedGraph={wikiSeed}
            onStopResearch={() => void stop()}
          />
        </section>

        {!running && !status?.task && (
          <section className="modal-section">
            <h3>What should I research?</h3>
            <form className="ds-start-form" onSubmit={(e) => void handleStart(e)}>
              <textarea
                autoFocus
                rows={2}
                className="ds-start-input"
                placeholder="e.g. recent empirical work on remote work productivity in knowledge sectors"
                value={taskDraft}
                onChange={(e) => setTaskDraft(e.target.value)}
              />
              <button
                type="submit"
                className="dp-btn dp-btn-primary"
                disabled={taskDraft.trim().length === 0}
              >
                Start research
              </button>
            </form>
          </section>
        )}

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

        {!running && status?.task && (
          <section className="modal-section ds-actions">
            <button
              type="button"
              className="dp-btn dp-btn-secondary"
              onClick={() => {
                setTaskDraft('');
                void useDeepSearch.getState().refresh();
              }}
            >
              Start another run
            </button>
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
