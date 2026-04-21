import { useEffect, useMemo, useState } from 'react';
import { useDeepPlan } from '../../store/deepPlan';

/**
 * Full-screen overlay shown while the drafter is running. Replaces the
 * old "watch text spawn into the doc" UX — the user explicitly asked for
 * a dedicated "generating" screen with a live word counter instead. The
 * finished draft lands in the document in one atomic write when the
 * stream closes.
 *
 * Reads `drafting` + `draftBuffer` out of the Deep Plan store. The buffer
 * is never rendered; we only derive a word count from it.
 */
export function DraftGenerationModal(): JSX.Element | null {
  const drafting = useDeepPlan((s) => s.drafting);
  const buffer = useDeepPlan((s) => s.draftBuffer);
  const fidelity = useDeepPlan((s) => s.fidelity);

  const wordCount = useMemo(() => {
    const trimmed = buffer.trim();
    if (trimmed.length === 0) return 0;
    return trimmed.split(/\s+/).length;
  }, [buffer]);

  // Three phases, in order: warming (no chunks yet) → writing (streaming
  // into the draft buffer) → verifying (fidelity loop running). Fidelity
  // updates only arrive after the stream closes, so we can detect its
  // phase purely from the presence of a `fidelity` payload.
  const verifying = fidelity !== null && fidelity.phase !== 'done';
  const phase = verifying ? 'verifying' : buffer.length === 0 ? 'warming' : 'writing';
  const label =
    phase === 'warming'
      ? 'Preparing draft…'
      : phase === 'writing'
        ? 'Writing draft…'
        : fidelity?.phase === 'critiquing'
          ? `Checking claims — round ${fidelity.round} / ${fidelity.maxRounds}`
          : `Repairing ${fidelity?.issueCount ?? 0} claim${
              (fidelity?.issueCount ?? 0) === 1 ? '' : 's'
            } — round ${fidelity?.round ?? 0} / ${fidelity?.maxRounds ?? 5}`;

  const displayCount = useSmoothCount(wordCount);

  if (!drafting) return null;

  return (
    <div className="dp-draft-modal" role="dialog" aria-live="polite" aria-busy="true">
      <div className="dp-draft-modal-card">
        <div className="dp-draft-modal-dots" aria-hidden="true">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
        <div className="dp-draft-modal-label">{label}</div>
        {phase !== 'verifying' && (
          <div className="dp-draft-modal-count">
            <span className="dp-draft-modal-count-num">{displayCount.toLocaleString()}</span>
            <span className="dp-draft-modal-count-unit">
              {displayCount === 1 ? 'word' : 'words'}
            </span>
          </div>
        )}
        {phase === 'verifying' && fidelity && fidelity.fixed > 0 && (
          <div className="dp-draft-modal-count">
            <span className="dp-draft-modal-count-num">{fidelity.fixed}</span>
            <span className="dp-draft-modal-count-unit">
              {fidelity.fixed === 1 ? 'claim patched' : 'claims patched'}
            </span>
          </div>
        )}
        <div className="dp-draft-modal-hint">
          {phase === 'verifying'
            ? 'Re-grounding every claim against your wiki. This usually takes under a minute per round.'
            : 'The finished draft will appear in your document when this wraps up.'}
        </div>
      </div>
    </div>
  );
}

/**
 * Tween the word counter so it feels alive rather than snapping in big
 * jumps when chunks arrive. Not a hard animation — we just step the
 * displayed number towards the target every frame-ish tick, capped at a
 * few dozen per step so long stretches catch up quickly.
 */
function useSmoothCount(target: number): number {
  const [display, setDisplay] = useState(target);
  useEffect(() => {
    if (display === target) return;
    const id = window.setTimeout(() => {
      setDisplay((prev) => {
        if (prev === target) return prev;
        const diff = target - prev;
        const step = Math.max(1, Math.ceil(Math.abs(diff) / 6));
        return diff > 0 ? prev + step : prev - step;
      });
    }, 40);
    return () => window.clearTimeout(id);
  }, [display, target]);
  return display;
}
