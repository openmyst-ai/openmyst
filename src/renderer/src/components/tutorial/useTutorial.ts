import { useCallback, useEffect, useState } from 'react';

/**
 * Persisted first-run flag for a named tutorial. Each tour has its own
 * localStorage key so skipping Deep Plan's tour doesn't silence the
 * editor tour. `reset` is exported for debug / "show me again" menu
 * hooks later.
 */

const PREFIX = 'tutorial-done:';

function read(name: string): boolean {
  try {
    return window.localStorage.getItem(PREFIX + name) === '1';
  } catch {
    return false;
  }
}

function write(name: string, done: boolean): void {
  try {
    if (done) window.localStorage.setItem(PREFIX + name, '1');
    else window.localStorage.removeItem(PREFIX + name);
  } catch {
    // Storage unavailable — tour will just replay next session. Fine.
  }
}

export function useTutorial(name: string): {
  shouldShow: boolean;
  markDone: () => void;
  reset: () => void;
} {
  const [done, setDone] = useState<boolean>(() => read(name));

  // Short delay on first visit so the target DOM has a chance to mount
  // and settle before we try to measure it.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (done) return;
    const t = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(t);
  }, [done]);

  const markDone = useCallback(() => {
    write(name, true);
    setDone(true);
  }, [name]);

  const reset = useCallback(() => {
    write(name, false);
    setDone(false);
  }, [name]);

  return { shouldShow: !done && ready, markDone, reset };
}
