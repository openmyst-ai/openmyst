import type { DeepPlanPhase } from '@shared/types';
import { DEEP_PLAN_PHASE_ORDER } from '@shared/types';
import { useDeepPlan } from '../../store/deepPlan';

interface Props {
  phase: DeepPlanPhase;
  onOpenSettings: () => void;
}

const PHASE_LABELS: Record<DeepPlanPhase, string> = {
  ideation: 'Ideation',
  planning: 'Planning',
  reviewing: 'Reviewing',
  done: 'Done',
};

const CONTINUE_LABELS: Record<DeepPlanPhase, string> = {
  ideation: 'Continue to planning',
  planning: 'Continue to reviewing',
  reviewing: 'Write the draft',
  done: 'Done',
};

export function StageBar({ phase, onOpenSettings }: Props): JSX.Element {
  const { status, busy, advance, oneShot, skip } = useDeepPlan();
  const visible = DEEP_PLAN_PHASE_ORDER.filter((p) => p !== 'done');
  const currentIdx = DEEP_PLAN_PHASE_ORDER.indexOf(phase);

  const roundRunning = status?.roundRunning ?? false;
  const isReviewing = phase === 'reviewing';
  const isDone = phase === 'done';

  let action: {
    label: string;
    onClick: () => void;
    kind: 'primary' | 'danger';
    disabled: boolean;
  } | null = null;
  if (!isDone) {
    if (isReviewing) {
      action = {
        label: busy ? 'Writing draft…' : CONTINUE_LABELS.reviewing,
        onClick: () => void oneShot(),
        kind: 'primary',
        disabled: busy || roundRunning,
      };
    } else {
      action = {
        label: CONTINUE_LABELS[phase],
        onClick: () => void advance(),
        kind: 'primary',
        disabled: busy || roundRunning,
      };
    }
  }

  return (
    <div className="dp-stagebar" data-tutorial="dp-stagebar">
      <div className="dp-stagebar-title">
        <span className="dp-stagebar-brand">Deep Plan</span>
        <span className="dp-stagebar-stage">· {PHASE_LABELS[phase]}</span>
      </div>
      <div className="dp-stagebar-steps">
        {visible.map((s, i) => {
          const idx = DEEP_PLAN_PHASE_ORDER.indexOf(s);
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
