import { useEffect, useRef, useState } from 'react';

/**
 * Typewriter-style smoothing for streaming text. Chunks arrive from the
 * network in uneven bursts — a single token decode can dump 30 chars in
 * one React update, then nothing for 500ms. This hook keeps an internal
 * `displayed` that catches up to `target` at ~60fps with an adaptive
 * rate, so prose lands letter-by-letter instead of jumping in bursts.
 *
 * Rules:
 *   - If `target` shrinks (new turn begins, stream reset), snap
 *     `displayed` to the new value instantly — no reverse animation.
 *   - If `target` grows, reveal ~1.5 chars/ms base, plus a catch-up
 *     term proportional to how far behind we are. This means the final
 *     chunks after the real stream ends still animate at a visible
 *     pace, rather than dumping all at once.
 */
export function useSmoothText(target: string): string {
  const [displayed, setDisplayed] = useState(target);
  const targetRef = useRef(target);
  const displayedRef = useRef(target);

  if (target.length < displayedRef.current.length) {
    displayedRef.current = target;
  }
  targetRef.current = target;

  useEffect(() => {
    if (target.length < displayed.length) {
      setDisplayed(target);
    }
  }, [target, displayed.length]);

  useEffect(() => {
    let rafId = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(64, now - last);
      last = now;
      const t = targetRef.current;
      const cur = displayedRef.current;
      if (cur.length < t.length) {
        const behind = t.length - cur.length;
        const charsPerMs = 0.08 + behind / 400;
        const reveal = Math.max(1, Math.round(dt * charsPerMs));
        const next = t.slice(0, Math.min(t.length, cur.length + reveal));
        displayedRef.current = next;
        setDisplayed(next);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return displayed;
}
