import { useMemo } from 'react';
import { useDeepPlan } from '../../store/deepPlan';
import { renderMarkdown } from '../../utils/markdown';
import { CitationHoverScope } from './CitationHoverScope';

/**
 * Right-column view of the living plan.md. The Chair rewrites this in full
 * each round; the renderer just displays whatever's latest. Empty-state copy
 * lives here too so the pane never looks broken before the first round.
 */
export function PlanColumn(): JSX.Element {
  const plan = useDeepPlan((s) => s.status?.session?.plan ?? '');

  const html = useMemo(() => (plan.trim() ? renderMarkdown(plan) : ''), [plan]);

  if (!plan.trim()) {
    return (
      <div className="dp-plan dp-plan-empty">
        <p className="dp-muted">
          The plan takes shape here. The panel rewrites it every round — think
          of this pane as a living outline that sharpens as you answer.
        </p>
      </div>
    );
  }

  return (
    <CitationHoverScope className="dp-plan-scope">
      <div className="dp-plan" dangerouslySetInnerHTML={{ __html: html }} />
    </CitationHoverScope>
  );
}
