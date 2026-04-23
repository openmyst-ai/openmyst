import { useMemo } from 'react';
import { useDeepPlan } from '../../store/deepPlan';
import { renderMarkdown } from '../../utils/markdown';
import { CitationHoverScope } from './CitationHoverScope';

/**
 * Vision.md view — the session's intellectual spine. Dot-points, not
 * prose; no citations; rewritten by the Chair only when the thesis / POV
 * / section intents actually move. Hover scope is still wired so any
 * short anchor references the Chair drops in vision are clickable, but
 * vision should mostly be clean text.
 */
export function VisionColumn(): JSX.Element {
  const vision = useDeepPlan((s) => s.status?.session?.vision ?? '');
  const html = useMemo(() => (vision.trim() ? renderMarkdown(vision) : ''), [vision]);

  if (!vision.trim()) {
    return (
      <div className="dp-plan dp-plan-empty">
        <p className="dp-muted">
          The vision takes shape here — thesis, POV, section intents, the
          novel insights you and the Chair surface through conversation.
          Vision is small and meaty: a short handful of dot-points, not a
          full plan. Anchors live separately in the Evidence tab.
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
