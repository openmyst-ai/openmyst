import { useCallback, useEffect, useState } from 'react';
import { USE_OPENMYST } from '@shared/flags';
import type { DeepPlanMode } from '@shared/types';
import { DEEP_PLAN_MODE_CONFIGS, DEEP_PLAN_MODES } from '@shared/types';
import { bridge } from '../api/bridge';
import { useApp } from '../store/app';
import { useDeepPlan } from '../store/deepPlan';
import { useResearchEvents } from '../store/researchEvents';
import { useMystLinkHandler } from '../hooks/useMystLinkHandler';
import { StageBar } from './deepPlan/StageBar';
import { SourcesColumn } from './deepPlan/SourcesColumn';
import { WikiGraphColumn } from './deepPlan/WikiGraphColumn';
import { VisionColumn } from './deepPlan/VisionColumn';
import { AnchorLogColumn } from './deepPlan/AnchorLogColumn';
import { ConversationColumn } from './deepPlan/ConversationColumn';
import { DraftGenerationModal } from './deepPlan/DraftGenerationModal';
import { SourcePreviewPopup } from './SourcePreview';
import { TutorialOverlay } from './tutorial/TutorialOverlay';
import { DEEP_PLAN_TUTORIAL } from './tutorial/steps';
import { useTutorial } from './tutorial/useTutorial';

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
    busy,
    error,
    refresh,
    start,
    ingestChunk,
    finishStream,
    applyPanelEvent,
    clearError,
  } = useDeepPlan();

  const [intentDraft, setIntentDraft] = useState('');
  const [intentMode, setIntentMode] = useState<DeepPlanMode>('argumentative-essay');
  const [rightTab, setRightTab] = useState<'vision' | 'anchors' | 'graph'>('vision');

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
    const offPanel = bridge.deepPlan.onPanelProgress(applyPanelEvent);
    return () => {
      offChanged();
      offChunk();
      offDone();
      offEvent();
      offPanel();
    };
  }, [refresh, ingestChunk, finishStream, pushResearchEvent, applyPanelEvent]);

  const handleStart = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!intentDraft.trim()) return;
      await start(intentDraft.trim(), intentMode);
    },
    [intentDraft, intentMode, start],
  );

  const session = status?.session ?? null;
  const needsIntent = !session;
  const hasOpenRouterKey = USE_OPENMYST ? true : (settings?.hasOpenRouterKey ?? false);

  const tutorial = useTutorial('deepPlan');

  return (
    <div className="dp-root">
      <StageBar
        phase={session?.phase ?? 'ideation'}
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
        <aside className="dp-col dp-col-left" data-tutorial="dp-sources">
          <SourcesColumn />
        </aside>

        <section className="dp-col dp-col-center" data-tutorial="dp-conversation">
          {needsIntent ? (
            <IntentForm
              project={project?.name ?? 'this project'}
              draft={intentDraft}
              onDraft={setIntentDraft}
              mode={intentMode}
              onMode={setIntentMode}
              onSubmit={handleStart}
              busy={busy}
              disabled={!hasOpenRouterKey}
            />
          ) : (
            <ConversationColumn session={session!} />
          )}
        </section>

        <aside className="dp-col dp-col-right" data-tutorial="dp-wiki">
          <div className="dp-right-tabs" role="tablist" aria-label="Right panel">
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'vision'}
              className={`dp-right-tab${rightTab === 'vision' ? ' dp-right-tab-active' : ''}`}
              onClick={() => setRightTab('vision')}
            >
              Vision
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'anchors'}
              className={`dp-right-tab${rightTab === 'anchors' ? ' dp-right-tab-active' : ''}`}
              onClick={() => setRightTab('anchors')}
            >
              Anchors
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightTab === 'graph'}
              className={`dp-right-tab${rightTab === 'graph' ? ' dp-right-tab-active' : ''}`}
              onClick={() => setRightTab('graph')}
            >
              Graph
            </button>
          </div>
          <div className="dp-right-tabpanel">
            {rightTab === 'vision' && <VisionColumn />}
            {rightTab === 'anchors' && <AnchorLogColumn />}
            {rightTab === 'graph' && <WikiGraphColumn />}
          </div>
        </aside>
      </div>

      <SourcePreviewPopup />
      <DraftGenerationModal />
      {tutorial.shouldShow && (
        <TutorialOverlay
          steps={DEEP_PLAN_TUTORIAL}
          onDone={tutorial.markDone}
          onSkip={tutorial.markDone}
        />
      )}
    </div>
  );
}

function IntentForm({
  project: _project,
  draft,
  onDraft,
  mode,
  onMode,
  onSubmit,
  busy,
  disabled,
}: {
  project: string;
  draft: string;
  onDraft: (s: string) => void;
  mode: DeepPlanMode;
  onMode: (m: DeepPlanMode) => void;
  onSubmit: (e: React.FormEvent) => void;
  busy: boolean;
  disabled: boolean;
}): JSX.Element {
  const config = DEEP_PLAN_MODE_CONFIGS[mode];
  return (
    <div className="dp-intent">
      <div className="dp-intent-card">
        <h1>What kind of work is this?</h1>
        <p className="dp-muted">
          Pick a deliverable — the panel and drafter shape themselves around your choice. Then describe what you're making.
        </p>
        <form onSubmit={onSubmit}>
          <div className="dp-mode-grid" role="radiogroup" aria-label="Deliverable mode">
            {DEEP_PLAN_MODES.map((id) => {
              const cfg = DEEP_PLAN_MODE_CONFIGS[id];
              const active = id === mode;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`dp-mode-card${active ? ' is-active' : ''}`}
                  onClick={() => onMode(id)}
                  disabled={busy || disabled}
                >
                  <span className="dp-mode-card-label">{cfg.label}</span>
                  <span className="dp-mode-card-blurb">{cfg.blurb}</span>
                </button>
              );
            })}
          </div>
          <textarea
            rows={5}
            className="dp-intent-textarea"
            placeholder={config.briefPlaceholder}
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
