import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * First-run coach-mark tutorial. Walks the user through the main surfaces
 * of a mode by spotlighting one element at a time and parking a bubble of
 * copy next to it. Click Next (or hit Enter / →) to advance; Skip or Esc
 * closes the flow.
 *
 * Targets are addressed by `data-tutorial="<id>"` attribute rather than
 * CSS selectors so the callers own the labels and nothing in the HTML
 * structure is load-bearing for the overlay.
 *
 * Missing targets are handled gracefully — the step shows as a centered
 * callout with no spotlight — so a flow that references an element only
 * present in a subset of states (e.g. "Stop research" appears only when
 * a run is live) still renders something useful.
 */

export interface TutorialStep {
  /** `data-tutorial` id to spotlight. Omit for a centered callout step. */
  target?: string;
  title: string;
  body: string;
  /** Preferred placement of the bubble relative to the target. */
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

interface TargetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  steps: TutorialStep[];
  onDone: () => void;
  onSkip: () => void;
}

const BUBBLE_WIDTH = 320;
const BUBBLE_MARGIN = 14;
const PAD = 8;

function readRect(id: string | undefined): TargetRect | null {
  if (!id) return null;
  const el = document.querySelector<HTMLElement>(`[data-tutorial="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function placeBubble(
  rect: TargetRect | null,
  placement: TutorialStep['placement'],
  viewport: { w: number; h: number },
): { top: number; left: number; placement: TutorialStep['placement'] } {
  if (!rect || placement === 'center') {
    return {
      top: Math.max(40, viewport.h / 2 - 120),
      left: Math.max(20, viewport.w / 2 - BUBBLE_WIDTH / 2),
      placement: 'center',
    };
  }
  const preferred: Array<NonNullable<TutorialStep['placement']>> = placement
    ? [placement]
    : [];
  const tries: Array<NonNullable<TutorialStep['placement']>> = [
    ...preferred,
    'bottom',
    'top',
    'right',
    'left',
  ];

  for (const p of tries) {
    if (p === 'bottom') {
      const top = rect.y + rect.h + BUBBLE_MARGIN;
      if (top + 180 < viewport.h) {
        return {
          top,
          left: clamp(rect.x + rect.w / 2 - BUBBLE_WIDTH / 2, 12, viewport.w - BUBBLE_WIDTH - 12),
          placement: 'bottom',
        };
      }
    }
    if (p === 'top') {
      const top = rect.y - 200 - BUBBLE_MARGIN;
      if (top > 12) {
        return {
          top,
          left: clamp(rect.x + rect.w / 2 - BUBBLE_WIDTH / 2, 12, viewport.w - BUBBLE_WIDTH - 12),
          placement: 'top',
        };
      }
    }
    if (p === 'right') {
      const left = rect.x + rect.w + BUBBLE_MARGIN;
      if (left + BUBBLE_WIDTH < viewport.w) {
        return {
          top: clamp(rect.y + rect.h / 2 - 90, 12, viewport.h - 200),
          left,
          placement: 'right',
        };
      }
    }
    if (p === 'left') {
      const left = rect.x - BUBBLE_WIDTH - BUBBLE_MARGIN;
      if (left > 12) {
        return {
          top: clamp(rect.y + rect.h / 2 - 90, 12, viewport.h - 200),
          left,
          placement: 'left',
        };
      }
    }
  }
  return {
    top: Math.max(40, viewport.h / 2 - 120),
    left: Math.max(20, viewport.w / 2 - BUBBLE_WIDTH / 2),
    placement: 'center',
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function TutorialOverlay({ steps, onDone, onSkip }: Props): JSX.Element | null {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [viewport, setViewport] = useState({
    w: window.innerWidth,
    h: window.innerHeight,
  });

  const step = steps[idx];

  // Re-measure target on step change + window resize + a short rAF loop
  // for the first few frames (layout can shift as streaming UIs settle).
  useLayoutEffect(() => {
    if (!step) return;
    let frames = 0;
    let raf = 0;
    const measure = (): void => {
      setRect(readRect(step.target));
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      if (frames++ < 10) raf = requestAnimationFrame(measure);
    };
    measure();
    const onResize = (): void => measure();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onSkip();
      } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => {
          if (i + 1 >= steps.length) {
            onDone();
            return i;
          }
          return i + 1;
        });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steps.length, onDone, onSkip]);

  if (!step) return null;

  const bubble = placeBubble(rect, step.placement, viewport);
  const isLast = idx === steps.length - 1;

  const next = (): void => {
    if (isLast) onDone();
    else setIdx((i) => i + 1);
  };
  const back = (): void => setIdx((i) => Math.max(0, i - 1));

  return (
    <div className="tutorial-root" role="dialog" aria-modal="true">
      {/* Four quadrant shades around the target — combine to dim
          everything except the spotlight hole. Each has pointer-events
          enabled so a misclick doesn't leak to the app. When there's no
          target we fall back to a single full-screen shade. */}
      {rect ? (
        <>
          <div
            className="tutorial-shade"
            style={{ top: 0, left: 0, width: '100vw', height: Math.max(0, rect.y - PAD) }}
          />
          <div
            className="tutorial-shade"
            style={{
              top: rect.y + rect.h + PAD,
              left: 0,
              width: '100vw',
              height: Math.max(0, viewport.h - (rect.y + rect.h + PAD)),
            }}
          />
          <div
            className="tutorial-shade"
            style={{
              top: Math.max(0, rect.y - PAD),
              left: 0,
              width: Math.max(0, rect.x - PAD),
              height: rect.h + PAD * 2,
            }}
          />
          <div
            className="tutorial-shade"
            style={{
              top: Math.max(0, rect.y - PAD),
              left: rect.x + rect.w + PAD,
              width: Math.max(0, viewport.w - (rect.x + rect.w + PAD)),
              height: rect.h + PAD * 2,
            }}
          />
          <div
            className="tutorial-ring"
            style={{
              top: rect.y - PAD,
              left: rect.x - PAD,
              width: rect.w + PAD * 2,
              height: rect.h + PAD * 2,
            }}
          />
        </>
      ) : (
        <div
          className="tutorial-shade"
          style={{ top: 0, left: 0, width: '100vw', height: '100vh' }}
        />
      )}

      <div
        className={`tutorial-bubble tutorial-bubble-${bubble.placement ?? 'center'}`}
        style={{ top: bubble.top, left: bubble.left, width: BUBBLE_WIDTH }}
      >
        <div className="tutorial-bubble-header">
          <span className="tutorial-bubble-step">
            {idx + 1} / {steps.length}
          </span>
          <button
            type="button"
            className="tutorial-bubble-skip"
            onClick={onSkip}
            aria-label="Skip tutorial"
          >
            Skip
          </button>
        </div>
        <h3 className="tutorial-bubble-title">{step.title}</h3>
        <p className="tutorial-bubble-body">{step.body}</p>
        <div className="tutorial-bubble-actions">
          <button
            type="button"
            className="tutorial-bubble-back"
            onClick={back}
            disabled={idx === 0}
          >
            Back
          </button>
          <button type="button" className="tutorial-bubble-next" onClick={next}>
            {isLast ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
