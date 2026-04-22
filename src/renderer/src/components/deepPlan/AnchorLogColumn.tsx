import { useEffect, useState } from 'react';
import type { AnchorLogEntry } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useDeepPlan } from '../../store/deepPlan';
import { CitationHoverScope } from './CitationHoverScope';

/**
 * Anchor-log view — deterministic flat list of every anchor extracted
 * from every ingested source. Reads via `sources.listAllAnchors`, which
 * is the union of every `<slug>.index.json` on disk. No panel curation,
 * no session-side log — what you see is exactly what the drafter will
 * receive at handoff.
 *
 * Refreshes whenever the session changes (new round finishes, new source
 * lands) — that's the cheapest signal we have that the underlying source
 * indexes may have grown.
 */
export function AnchorLogColumn(): JSX.Element {
  const sessionChangeSignal = useDeepPlan((s) => s.status?.session);
  const [anchors, setAnchors] = useState<AnchorLogEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge.sources.listAllAnchors().then((list) => {
      if (!cancelled) setAnchors(list);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionChangeSignal]);

  if (anchors === null) {
    return (
      <div className="dp-plan dp-plan-empty">
        <p className="dp-muted">Loading anchors…</p>
      </div>
    );
  }

  if (anchors.length === 0) {
    return (
      <div className="dp-plan dp-plan-empty">
        <p className="dp-muted">
          The evidence pile fills automatically as sources get ingested.
          Every anchor the digest extracts from a source appears here —
          no curation step in between. Ingest a source or run a research
          round and anchors land.
        </p>
      </div>
    );
  }

  return (
    <CitationHoverScope className="dp-anchor-log-scope">
      <div className="dp-anchor-log">
        <div className="dp-anchor-log-count">
          {anchors.length} {anchors.length === 1 ? 'anchor' : 'anchors'}
        </div>
        {anchors.map((entry) => (
          <AnchorLogItem key={entry.id} entry={entry} />
        ))}
      </div>
    </CitationHoverScope>
  );
}

function AnchorLogItem({ entry }: { entry: AnchorLogEntry }): JSX.Element {
  const anchorFragment = entry.id.split('#')[1] ?? '';
  return (
    <article className="dp-anchor-entry">
      <header className="dp-anchor-entry-head">
        <span className={`dp-anchor-entry-type dp-anchor-entry-type-${entry.type}`}>
          {entry.type}
        </span>
        {/* Link uses the same (slug.md#anchor-id) shape as citations in plan + drafts
         *  so the existing hover popover resolves it with zero special-casing. */}
        <a
          className="dp-anchor-entry-source"
          href={`${entry.slug}.md#${anchorFragment}`}
          target="_blank"
          rel="noreferrer"
        >
          {entry.sourceName}
        </a>
      </header>
      <p className="dp-anchor-entry-text">{entry.text}</p>
    </article>
  );
}
