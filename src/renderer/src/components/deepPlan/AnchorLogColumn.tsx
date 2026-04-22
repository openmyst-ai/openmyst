import { useDeepPlan } from '../../store/deepPlan';
import type { AnchorLogEntry } from '@shared/types';
import { CitationHoverScope } from './CitationHoverScope';

/**
 * Anchor-log view — the append-only evidence pile. Each entry shows
 * source chip, type badge, verbatim text, and (optionally) the Chair's
 * note on why the anchor matters. Wrapped in CitationHoverScope so
 * each entry's header link resolves via the same hover preview used in
 * the conversation column and the drafter output.
 */
export function AnchorLogColumn(): JSX.Element {
  const log = useDeepPlan((s) => s.status?.session?.anchorLog ?? []);

  if (log.length === 0) {
    return (
      <div className="dp-plan dp-plan-empty">
        <p className="dp-muted">
          The evidence log fills as the panel proposes anchors and the
          Chair curates them in. Each entry is a verbatim passage from a
          credible source, keyed by <code>slug#anchor-id</code>. Target
          end-state: 20–50 entries by the time you're ready to draft.
        </p>
      </div>
    );
  }

  return (
    <CitationHoverScope className="dp-anchor-log-scope">
      <div className="dp-anchor-log">
        <div className="dp-anchor-log-count">
          {log.length} {log.length === 1 ? 'anchor' : 'anchors'}
        </div>
        {log.map((entry) => (
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
        {/* Link uses the same (slug.md#anchor-id) shape as citations in plan + drafts so
         *  the existing hover popover resolves it with zero special-casing. */}
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
      {entry.note && <p className="dp-anchor-entry-note">{entry.note}</p>}
    </article>
  );
}
