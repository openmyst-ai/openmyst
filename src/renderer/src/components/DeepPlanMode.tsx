import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../api/bridge';
import { useApp } from '../store/app';
import { useDeepPlan } from '../store/deepPlan';
import { useResearchEvents } from '../store/researchEvents';
import { useMystLinkHandler } from '../hooks/useMystLinkHandler';
import { StageBar } from './deepPlan/StageBar';
import { SourcesColumn } from './deepPlan/SourcesColumn';
import { WikiGraphColumn } from './deepPlan/WikiGraphColumn';
import { ConversationColumn } from './deepPlan/ConversationColumn';
import { SourcePreviewPopup } from './SourcePreview';

/**
 * Full-screen Deep Plan mode. Takes over the whole app when a new project is
 * first opened (or when the user explicitly enters it). Left column is
 * sources, center is the planner conversation, right is the live wiki graph.
 * Top bar shows stage progress + cost meter + skip-to-editor.
 *
 * Lifecycle:
 *   - Mount → refresh() pulls status from main, subscribes to changed +
 *     chunk streams.
 *   - User lands on an intent prompt if no session exists yet, then starts
 *     via `start(task)` which scaffolds the session and primes stage 1.
 *   - Skip / Complete hide the view, letting App.tsx fall through to Layout.
 */

export function DeepPlanMode(): JSX.Element {
  const { project, openSettings, settings } = useApp();
  const {
    status,
    streaming,
    streamingBuffer,
    busy,
    error,
    refresh,
    start,
    skip,
    ingestChunk,
    finishStream,
    clearError,
  } = useDeepPlan();

  const [intentDraft, setIntentDraft] = useState('');

  const pushResearchEvent = useResearchEvents((s) => s.push);

  // Without this, clicking an internal markdown link inside the source
  // preview popup (e.g. `[...](four_different_types_of_attention.md)`) falls
  // through to the browser's default anchor handling, which reloads the tab —
  // wiping the researchEvents store mid-run so the graph snaps back to
  // "Waiting for the first query…" while the background engine keeps going.
  useMystLinkHandler();

  useEffect(() => {
    void refresh();
    const offChanged = bridge.deepPlan.onChanged(() => {
      void refresh();
    });
    const offChunk = bridge.deepPlan.onChunk(ingestChunk);
    const offDone = bridge.deepPlan.onChunkDone(finishStream);
    const offEvent = bridge.deepPlan.onResearchEvent(pushResearchEvent);
    return () => {
      offChanged();
      offChunk();
      offDone();
      offEvent();
    };
  }, [refresh, ingestChunk, finishStream, pushResearchEvent]);

  const handleStart = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!intentDraft.trim()) return;
      await start(intentDraft.trim());
    },
    [intentDraft, start],
  );

  const session = status?.session ?? null;
  const needsIntent = !session || session.stage === 'intent';
  const hasOpenRouterKey = settings?.hasOpenRouterKey ?? false;

  return (
    <div className="dp-root">
      <StageBar
        stage={session?.stage ?? 'intent'}
        tokensUsedK={session?.tokensUsedK ?? 0}
        onOpenSettings={openSettings}
      />

      {error && (
        <div className="dp-error">
          <span>{error}</span>
          <button type="button" className="link" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}

      {!hasOpenRouterKey && (
        <div className="dp-warn">
          <span>Deep Plan needs an OpenRouter API key to call the planner model.</span>
          <button type="button" className="link" onClick={openSettings}>
            Open Settings
          </button>
        </div>
      )}

      <div className="dp-body">
        <aside className="dp-col dp-col-left">
          <SourcesColumn />
        </aside>

        <section className="dp-col dp-col-center">
          {needsIntent ? (
            <IntentForm
              project={project?.name ?? 'this project'}
              draft={intentDraft}
              onDraft={setIntentDraft}
              onSubmit={handleStart}
              busy={busy}
              disabled={!hasOpenRouterKey}
            />
          ) : (
            <ConversationColumn session={session!} />
          )}
          {streaming && needsIntent && (
            <div className="dp-stream-pre">{streamingBuffer}</div>
          )}
        </section>

        <aside className="dp-col dp-col-right">
          <WikiGraphColumn />
        </aside>
      </div>

      <div className="dp-footer">
        <button type="button" className="link" onClick={() => void skip()}>
          Skip Deep Plan
        </button>
      </div>

      <SourcePreviewPopup />
    </div>
  );
}

function IntentForm({
  project,
  draft,
  onDraft,
  onSubmit,
  busy,
  disabled,
}: {
  project: string;
  draft: string;
  onDraft: (s: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  busy: boolean;
  disabled: boolean;
}): JSX.Element {
  return (
    <div className="dp-intent">
      <div className="dp-intent-card">
        <h1>What are we making?</h1>
        <p className="dp-muted">
          Describe the piece of writing you want to end up with. A few sentences is plenty —
          the planner will ask follow-up questions.
        </p>
        <form onSubmit={onSubmit}>
          <textarea
            autoFocus
            rows={6}
            className="dp-intent-textarea"
            placeholder={`e.g. An essay for ${project} exploring the future of open-source model economics…`}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            disabled={busy || disabled}
          />
          <div className="dp-intent-actions">
            <button
              type="submit"
              className="dp-btn dp-btn-primary"
              disabled={busy || disabled || draft.trim().length === 0}
            >
              {busy ? 'Starting…' : 'Start Deep Plan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
