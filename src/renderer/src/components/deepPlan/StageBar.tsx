import type { DeepPlanStage } from '@shared/types';
import { DEEP_PLAN_STAGE_ORDER } from '@shared/types';

interface Props {
  stage: DeepPlanStage;
  tokensUsedK: number;
  onOpenSettings: () => void;
}

const STAGE_LABELS: Record<DeepPlanStage, string> = {
  intent: 'Intent',
  sources: 'Sources',
  scoping: 'Scoping',
  gaps: 'Gaps',
  research: 'Research',
  clarify: 'Clarify',
  review: 'Review',
  handoff: 'Handoff',
  done: 'Done',
};

export function StageBar({ stage, tokensUsedK, onOpenSettings }: Props): JSX.Element {
  const visible = DEEP_PLAN_STAGE_ORDER.filter((s) => s !== 'done');
  const currentIdx = DEEP_PLAN_STAGE_ORDER.indexOf(stage);

  return (
    <div className="dp-stagebar">
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
        <span className="dp-stagebar-meter" title="Deep research tokens used">
          {tokensUsedK.toFixed(1)}K tokens
        </span>
        <button
          type="button"
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
