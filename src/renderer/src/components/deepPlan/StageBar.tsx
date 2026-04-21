import type { DeepPlanStage } from '@shared/types';
import { DEEP_PLAN_STAGE_ORDER } from '@shared/types';
import { useDeepPlan } from '../../store/deepPlan';

interface Props {
  stage: DeepPlanStage;
  onOpenSettings: () => void;
}

const STAGE_LABELS: Record<DeepPlanStage, string> = {
  intent: 'Intent',
  sources: 'Sources',
  scoping: 'Scoping',
  gaps: 'Gaps',
  research: 'Research',
  synthesis: 'Synthesis',
  handoff: 'Handoff',
  done: 'Done',
};

const CONTINUE_LABELS: Record<DeepPlanStage, string> = {
  intent: 'Continue',
  sources: 'Continue to scoping',
  scoping: 'Continue to gaps',
  gaps: 'Continue to research',
  research: 'Continue to synthesis',
  synthesis: 'Write the draft',
  handoff: 'Generating…',
  done: 'Done',
};

export function StageBar({ stage, onOpenSettings }: Props): JSX.Element {
  const { status, busy, advance, oneShot, stopResearch, runResearch, skip } = useDeepPlan();
  const visible = DEEP_PLAN_STAGE_ORDER.filter((s) => s !== 'done');
  const currentIdx = DEEP_PLAN_STAGE_ORDER.indexOf(stage);

  const researchRunning = status?.researchRunning ?? false;
  const isResearch = stage === 'research';
  const isSynthesis = stage === 'synthesis';
  const isDone = stage === 'done';
  const isIntent = stage === 'intent';

  // The stage bar owns the "advance the stage" action. During research it
  // flips to a Stop button while the run is live; in review it's the
  // one-shot draft trigger. Everywhere else it's a plain Continue.
  let action: { label: string; onClick: () => void; kind: 'primary' | 'danger'; disabled: boolean } | null = null;
  if (!isDone && !isIntent) {
    if (isResearch && researchRunning) {
      action = {
        label: 'Stop research',
        onClick: () => void stopResearch(),
        kind: 'danger',
        disabled: false,
      };
    } else if (isSynthesis) {
      action = {
        label: busy ? 'Writing draft…' : CONTINUE_LABELS.synthesis,
        onClick: () => void oneShot(),
        kind: 'primary',
        disabled: busy,
      };
    } else {
      action = {
        label: CONTINUE_LABELS[stage],
        onClick: () => void advance(),
        kind: 'primary',
        disabled: busy || (isResearch && researchRunning),
      };
    }
  }

  return (
    <div className="dp-stagebar" data-tutorial="dp-stagebar">
      <div className="dp-stagebar-title">
        <span className="dp-stagebar-brand">Deep Plan</span>
        <span className="dp-stagebar-stage">· {STAGE_LABELS[stage]}</span>
      </div>
      <div className="dp-stagebar-steps">
        {visible.map((s, i) => {
          const idx = DEEP_PLAN_STAGE_ORDER.indexOf(s);
          const state = idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : 'pending';
          return (
            <div key={s} className={`dp-stagebar-step dp-stagebar-step-${state}`}>
              <div className="dp-stagebar-dot" />
              {i < visible.length - 1 && <div className="dp-stagebar-line" />}
            </div>
          );
        })}
      </div>
      <div className="dp-stagebar-right">
        {isResearch && !researchRunning && (
          <button
            type="button"
            className="dp-btn dp-btn-secondary dp-btn-small"
            onClick={() => void runResearch()}
            disabled={busy}
          >
            Continue researching
          </button>
        )}
        {action && (
          <button
            type="button"
            data-tutorial="dp-advance"
            className={
              action.kind === 'danger'
                ? 'dp-btn dp-btn-danger dp-btn-small'
                : 'dp-btn dp-btn-primary dp-btn-small'
            }
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </button>
        )}
        {!isDone && (
          <button
            type="button"
            data-tutorial="dp-skip"
            className="dp-btn dp-btn-ghost dp-btn-small"
            onClick={() => void skip()}
            disabled={busy}
            title="Skip Deep Plan and go straight to the draft"
          >
            Skip Deep Plan
          </button>
        )}
        <button
          type="button"
          data-tutorial="dp-settings"
          className="dp-stagebar-skip"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          Settings
        </button>
      </div>
    </div>
  );
}
