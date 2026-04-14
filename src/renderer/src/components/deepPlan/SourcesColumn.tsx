import { useCallback, useEffect, useState } from 'react';
import type { SourceMeta } from '@shared/types';
import { bridge } from '../../api/bridge';
import { useSourcePreview } from '../../store/sourcePreview';

/**
 * Left-column source list for Deep Plan. Lighter-weight than the full
 * SourcesPanel — no wiki graph button, no delete (user can manage from
 * the main editor afterwards), just "what's in the wiki" + an add button.
 */

export function SourcesColumn(): JSX.Element {
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [ingesting, setIngesting] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const openPreview = useSourcePreview((s) => s.open);

  const load = useCallback(() => {
    bridge.sources.list().then(setSources).catch(console.error);
  }, []);

  useEffect(() => {
    load();
    const off = bridge.sources.onChanged(load);
    return off;
  }, [load]);

  const handleFilePick = useCallback(async () => {
    const paths = await bridge.sources.pickFiles();
    if (paths.length === 0) return;
    setIngesting(true);
    try {
      await bridge.sources.ingest(paths);
    } catch (err) {
      console.error('Source ingestion failed:', err);
    } finally {
      setIngesting(false);
    }
  }, []);

  return (
    <div className="dp-sources">
      <div className="dp-col-header">
        <h3>Sources</h3>
        <span className="dp-muted">{sources.length}</span>
      </div>

      <div className="dp-sources-list">
        {sources.length === 0 && (
          <div className="dp-empty">
            Drop in whatever you already have — papers, notes, transcripts. The planner
            reads everything here to shape the plan.
          </div>
        )}
        {sources.map((s) => (
          <button
            key={s.slug}
            type="button"
            className="dp-source-item"
            onClick={() => openPreview(s)}
          >
            <div className="dp-source-name">{s.name}</div>
            <div className="dp-source-summary">{s.indexSummary}</div>
          </button>
        ))}
      </div>

      <div className="dp-sources-actions">
        <button
          type="button"
          className="dp-btn"
          onClick={() => void handleFilePick()}
          disabled={ingesting}
        >
          {ingesting ? 'Processing…' : '+ Add file'}
        </button>
        <button
          type="button"
          className="dp-btn dp-btn-ghost"
          onClick={() => setShowPaste(true)}
          disabled={ingesting}
        >
          Paste text
        </button>
      </div>

      {showPaste && (
        <PasteDialog
          onClose={() => setShowPaste(false)}
          onIngesting={() => setIngesting(true)}
          onDone={() => setIngesting(false)}
        />
      )}
    </div>
  );
}

function PasteDialog({
  onClose,
  onIngesting,
  onDone,
}: {
  onClose: () => void;
  onIngesting: () => void;
  onDone: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  const submit = useCallback(async () => {
    if (!text.trim()) return;
    onIngesting();
    onClose();
    try {
      await bridge.sources.ingestText(text, title.trim() || 'Pasted source');
    } catch (err) {
      console.error('Paste ingestion failed:', err);
    } finally {
      onDone();
    }
  }, [text, title, onIngesting, onDone, onClose]);

  return (
    <div className="dp-modal-backdrop" onClick={onClose}>
      <div className="dp-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Paste text</h3>
        <input
          type="text"
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          placeholder="Paste the source text here…"
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="dp-modal-actions">
          <button type="button" className="dp-btn dp-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dp-btn"
            onClick={() => void submit()}
            disabled={!text.trim()}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
