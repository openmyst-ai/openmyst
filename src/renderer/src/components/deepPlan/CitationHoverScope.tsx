import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { SourceAnchor } from '@shared/types';
import { bridge } from '../../api/bridge';

/**
 * Wraps any subtree and turns every `[name](slug.md)` or `[name](slug.md#anchor)`
 * markdown link inside it into a hover-preview. On mouse-enter we parse the
 * href, resolve the anchor (or source summary) via the `sources.lookupAnchor`
 * IPC, and float a popover with the verbatim passage next to the link.
 *
 * Deliberately event-delegated: the inner HTML is rendered `dangerouslySetInnerHTML`
 * by markdown-it, so we can't attach React props per-link. One listener on the
 * root catches them all.
 *
 * Caches resolved lookups in a Map keyed by `slug#anchor` so we don't re-hit
 * disk every time the cursor crosses the same citation.
 */

interface PopoverState {
  x: number;
  y: number;
  slug: string;
  anchorId: string | null;
  status: 'loading' | 'loaded' | 'missing' | 'error';
  anchor?: SourceAnchor;
  sourceName?: string;
  sourceUrl?: string;
  error?: string;
}

type CacheValue =
  | {
      status: 'loaded';
      anchor?: SourceAnchor;
      sourceName?: string;
      sourceUrl?: string;
    }
  | { status: 'missing' }
  | { status: 'error'; error: string };

const cache = new Map<string, CacheValue>();

function parseHref(href: string): { slug: string; anchorId: string | null } | null {
  if (!href) return null;
  // Strip query, keep fragment. Only match relative links of the form
  // "slug.md" or "slug.md#anchor-id". Full URLs, mailto, anchors-only, etc.
  // are ignored — citations are always markdown slug links.
  const clean = href.split('?')[0] ?? '';
  const match = clean.match(/^([A-Za-z0-9_\-./]+?)\.md(?:#([A-Za-z0-9_\-.]+))?$/);
  if (!match) return null;
  const slugPath = match[1]!;
  // Slug is the last path segment, mirroring how plan.md links ("smith-2022.md")
  // and how anchors are labelled in the sources directory.
  const slug = slugPath.split('/').filter(Boolean).pop() ?? slugPath;
  const anchorId = match[2] ? match[2] : null;
  return { slug, anchorId };
}

function findCitationAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  let node = target as HTMLElement | null;
  while (node && node.nodeType === 1) {
    if (node.tagName === 'A') {
      const href = (node as HTMLAnchorElement).getAttribute('href') ?? '';
      if (parseHref(href)) return node as HTMLAnchorElement;
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

interface CitationHoverScopeProps {
  children: React.ReactNode;
  className?: string;
}

export const CitationHoverScope = forwardRef<HTMLDivElement, CitationHoverScopeProps>(
  function CitationHoverScope({ children, className }, forwardedRef): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(forwardedRef, () => rootRef.current!, []);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setPopover(null);
    }, 120);
  }, [clearHideTimer]);

  const showFor = useCallback(
    async (link: HTMLAnchorElement) => {
      const href = link.getAttribute('href') ?? '';
      const parsed = parseHref(href);
      if (!parsed) return;
      const key = `${parsed.slug}#${parsed.anchorId ?? ''}`;
      const rect = link.getBoundingClientRect();
      const base: PopoverState = {
        x: rect.left + rect.width / 2,
        y: rect.bottom + 6,
        slug: parsed.slug,
        anchorId: parsed.anchorId,
        status: 'loading',
      };
      const cached = cache.get(key);
      if (cached) {
        setPopover({ ...base, ...cached });
        return;
      }
      setPopover(base);
      if (!parsed.anchorId) {
        // No anchor fragment — show slug-only hint. We could fetch the source
        // summary here later; for now the popover just confirms the slug
        // resolves to a known wiki source.
        const value: CacheValue = { status: 'loaded' };
        cache.set(key, value);
        setPopover({ ...base, ...value });
        return;
      }
      try {
        const hit = await bridge.sources.lookupAnchor(parsed.slug, parsed.anchorId);
        if (!hit) {
          const value: CacheValue = { status: 'missing' };
          cache.set(key, value);
          setPopover({ ...base, ...value });
          return;
        }
        const value: CacheValue = {
          status: 'loaded',
          anchor: hit.anchor,
          sourceName: hit.sourceName,
          sourceUrl: hit.sourceUrl,
        };
        cache.set(key, value);
        setPopover((prev) =>
          prev && prev.slug === parsed.slug && prev.anchorId === parsed.anchorId
            ? { ...prev, ...value }
            : prev,
        );
      } catch (err) {
        const value: CacheValue = {
          status: 'error',
          error: (err as Error).message,
        };
        cache.set(key, value);
        setPopover((prev) =>
          prev && prev.slug === parsed.slug && prev.anchorId === parsed.anchorId
            ? { ...prev, ...value }
            : prev,
        );
      }
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onOver = (e: MouseEvent): void => {
      const link = findCitationAnchor(e.target);
      if (!link) return;
      clearHideTimer();
      void showFor(link);
    };
    const onOut = (e: MouseEvent): void => {
      const link = findCitationAnchor(e.target);
      if (!link) return;
      const toEl = e.relatedTarget as Node | null;
      if (toEl && link.contains(toEl)) return;
      scheduleHide();
    };
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
    };
  }, [showFor, clearHideTimer, scheduleHide]);

  useEffect(() => {
    return () => clearHideTimer();
  }, [clearHideTimer]);

  return (
    <div ref={rootRef} className={className}>
      {children}
      {popover && (
        <CitationPopover
          state={popover}
          onMouseEnter={clearHideTimer}
          onMouseLeave={scheduleHide}
        />
      )}
    </div>
  );
},
);

interface CitationPopoverProps {
  state: PopoverState;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function CitationPopover({
  state,
  onMouseEnter,
  onMouseLeave,
}: CitationPopoverProps): JSX.Element {
  const { x, y, slug, anchorId, status, anchor, sourceName, sourceUrl, error } = state;
  const title = sourceName ?? slug;
  return (
    <div
      className="dp-citation-hover"
      style={{ left: x, top: y }}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="dp-citation-hover-title">{title}</div>
      {sourceUrl && (
        <a
          className="dp-citation-hover-url"
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          {sourceUrl}
        </a>
      )}
      {anchorId && (
        <div className="dp-citation-hover-meta">
          <span className="dp-citation-hover-label">anchor</span>
          <span className="dp-citation-hover-anchor">#{anchorId}</span>
          {anchor?.type && (
            <span className="dp-citation-hover-type">[{anchor.type}]</span>
          )}
        </div>
      )}
      {status === 'loading' && (
        <div className="dp-citation-hover-body dp-citation-hover-loading">
          Reading source…
        </div>
      )}
      {status === 'loaded' && anchor?.keywords && anchor.keywords.length > 0 && (
        <div className="dp-citation-hover-keywords">
          {anchor.keywords.map((kw) => (
            <span key={kw} className="dp-citation-hover-kw">{kw}</span>
          ))}
        </div>
      )}
      {status === 'loaded' && !anchorId && (
        <div className="dp-citation-hover-body dp-citation-hover-muted">
          Slug-only citation — no specific anchor.
        </div>
      )}
      {status === 'missing' && (
        <div className="dp-citation-hover-body dp-citation-hover-muted">
          Anchor not found in the source index.
        </div>
      )}
      {status === 'error' && (
        <div className="dp-citation-hover-body dp-citation-hover-error">
          Couldn't read the anchor: {error}
        </div>
      )}
    </div>
  );
}
