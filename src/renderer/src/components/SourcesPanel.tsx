import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceMeta } from '@shared/types';
import { useSourcePreview } from '../store/sourcePreview';
import { bridge } from '../api/bridge';

type AddMode = null | 'options' | 'paste';

export function SourcesPanel(): JSX.Element {
  const [sources, setSources] = useState<SourceMeta[]>([]);
  const [ingesting, setIngesting] = useState(false);
  const [showAddPopup, setShowAddPopup] = useState(false);
  const openPreview = useSourcePreview((s) => s.open);

  const loadSources = useCallback(() => {
    bridge.sources.list().then(setSources).catch(console.error);
  }, []);

  useEffect(() => {
    loadSources();
    const off = bridge.sources.onChanged(loadSources);
    return off;
  }, [loadSources]);

  const handleDelete = useCallback(async (e: React.MouseEvent, slug: string) => {
    e.stopPropagation();
    await bridge.sources.delete(slug);
  }, []);

  return (
    <div className="sources-panel">
      <div className="sources-panel-header">
        <h2>Sources</h2>
      </div>

      {sources.length > 0 && (
        <div className="source-list-scroll">
          {sources.map((s) => (
            <button
              key={s.slug}
              type="button"
              className="source-name-btn"
              onClick={() => openPreview(s)}
            >
              <span className="source-name-label">{s.name}</span>
              <span
                className="source-name-delete"
                role="button"
                tabIndex={0}
                onClick={(e) => void handleDelete(e, s.slug)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleDelete(e as unknown as React.MouseEvent, s.slug); }}
              >
                &#x2715;
              </span>
            </button>
          ))}
        </div>
      )}

      {ingesting && (
        <div className="source-ingesting">
          <span className="generating-dots">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </span>
          {' '}Processing source…
        </div>
      )}

      {!ingesting && (
        <button
          type="button"
          className="source-add-btn"
          onClick={() => setShowAddPopup(true)}
        >
          + Add Source
        </button>
      )}

      {showAddPopup && (
        <AddSourcePopup
          onClose={() => setShowAddPopup(false)}
          onIngesting={() => { setShowAddPopup(false); setIngesting(true); }}
          onDone={() => setIngesting(false)}
        />
      )}
    </div>
  );
}

function AddSourcePopup({
  onClose,
  onIngesting,
  onDone,
}: {
  onClose: () => void;
  onIngesting: () => void;
  onDone: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<AddMode>('options');

  const handleFilePick = useCallback(async () => {
    const paths = await bridge.sources.pickFiles();
    if (paths.length === 0) return;
    onIngesting();
    try {
      await bridge.sources.ingest(paths);
    } catch (err) {
      console.error('Source ingestion failed:', err);
    } finally {
      onDone();
    }
  }, [onIngesting, onDone]);

  return (
    <div className="source-add-overlay" onClick={onClose}>
      <div className="source-add-popup" onClick={(e) => e.stopPropagation()}>
        <div className="source-add-popup-header">
          <h3>Add Source</h3>
          <button type="button" className="source-preview-close" onClick={onClose}>
            &#x2715;
          </button>
        </div>

        {mode === 'options' && (
          <div className="source-add-popup-options">
            <button type="button" className="source-popup-option" onClick={() => setMode('paste')}>
              <span className="source-popup-option-icon">&#x1F4CB;</span>
              <div>
                <div className="source-popup-option-title">Paste text</div>
                <div className="source-popup-option-desc">Paste content directly</div>
              </div>
            </button>
            <button type="button" className="source-popup-option" onClick={() => void handleFilePick()}>
              <span className="source-popup-option-icon">&#x1F4C4;</span>
              <div>
                <div className="source-popup-option-title">File</div>
                <div className="source-popup-option-desc">Upload a PDF or Markdown file</div>
              </div>
            </button>
            <button type="button" className="source-popup-option source-popup-option-disabled" disabled>
              <span className="source-popup-option-icon">&#x1F517;</span>
              <div>
                <div className="source-popup-option-title">Link</div>
                <div className="source-popup-option-desc">Coming soon</div>
              </div>
            </button>
          </div>
        )}

        {mode === 'paste' && (
          <PasteForm
            onDone={() => { onDone(); onClose(); }}
            onIngesting={onIngesting}
            onBack={() => setMode('options')}
          />
        )}
      </div>
    </div>
  );
}

function PasteForm({
  onDone,
  onIngesting,
  onBack,
}: {
  onDone: () => void;
  onIngesting: () => void;
  onBack: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!text.trim()) return;
    const t = title.trim() || 'Pasted source';
    onIngesting();
    try {
      await bridge.sources.ingestText(text, t);
    } catch (err) {
      console.error('Paste ingestion failed:', err);
    }
    onDone();
  }, [text, title, onDone, onIngesting]);

  return (
    <div className="source-paste-form">
      <input
        type="text"
        className="source-paste-title"
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        ref={textRef}
        className="source-paste-text"
        placeholder="Paste your source text here…"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="source-paste-actions">
        <button type="button" className="source-paste-submit" onClick={() => void handleSubmit()} disabled={!text.trim()}>
          Add Source
        </button>
        <button type="button" className="source-option-cancel" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
