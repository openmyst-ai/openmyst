import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceMeta } from '@shared/types';
import { useSourcePreview } from '../store/sourcePreview';
import { bridge } from '../api/bridge';

type AddMode = 'root' | 'paste' | 'link';

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

  const getOriginLabel = (s: SourceMeta): string | null => {
    // Show origin for ANY source whose `sourcePath` parses as a URL —
    // this covers `link` ingests AND pasted text where the user included
    // a URL (the ingest pipeline extracts those into `sourcePath`).
    // Non-URL paths (raw files, local PDFs) get a type-based label
    // instead so the bubble always shows something under the title.
    if (s.sourcePath) {
      try {
        const host = new URL(s.sourcePath).hostname.replace(/^www\./, '');
        // Strip the TLD + any preceding subdomain so e.g. "journals.nature.com"
        // shows as "nature" and "medium.com/x/y" shows as "medium". Take the
        // second-to-last segment when present (the registrable name minus
        // TLD); for short hostnames like "github.com" use the first segment.
        const parts = host.split('.');
        if (parts.length >= 2) return parts[parts.length - 2]!;
        return parts[0]!;
      } catch {
        // Fall through to type-based label below.
      }
    }
    switch (s.type) {
      case 'pdf':
        return 'pdf';
      case 'markdown':
        return 'markdown';
      case 'text':
        return 'text';
      case 'pasted':
        return 'pasted';
      case 'raw': {
        // Spreadsheets land in the raw bucket but get a friendlier label.
        const ext = (s.originalName.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
        if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') return 'spreadsheet';
        return 'file';
      }
      default:
        return null;
    }
  };

  return (
    <div className="sources-panel">
      <div className="sources-panel-header">
        <h2>Sources</h2>
      </div>

      {sources.length > 0 && (
        <div className="source-list-scroll">
          {sources.map((s) => {
            const origin = getOriginLabel(s);
            return (
              <button
                key={s.slug}
                type="button"
                className="source-name-btn"
                onClick={() => openPreview(s)}
              >
                <span className="source-name-label">
                  <span className="source-name-title">{s.name}</span>
                  {origin && (
                    <span className="source-name-origin">Source: {origin}</span>
                  )}
                </span>
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
            );
          })}
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

function UploadIcon(): JSX.Element {
  return (
    <svg className="source-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

function PasteIcon(): JSX.Element {
  return (
    <svg className="source-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="M8 10h8M8 14h8M8 18h5" />
    </svg>
  );
}

function LinkIcon(): JSX.Element {
  return (
    <svg className="source-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
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
  const [mode, setMode] = useState<AddMode>('root');
  const [dragOver, setDragOver] = useState(false);

  const ingestPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      onIngesting();
      try {
        await bridge.sources.ingest(paths);
      } catch (err) {
        console.error('Source ingestion failed:', err);
      } finally {
        onDone();
      }
    },
    [onIngesting, onDone],
  );

  const handleBrowse = useCallback(async () => {
    const paths = await bridge.sources.pickFiles();
    await ingestPaths(paths);
  }, [ingestPaths]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      const paths = files
        .map((f) => (f as unknown as { path?: string }).path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      void ingestPaths(paths);
    },
    [ingestPaths],
  );

  return (
    <div className="source-add-overlay" onClick={onClose}>
      <div className="source-add-popup" onClick={(e) => e.stopPropagation()}>
        <div className="source-add-popup-header">
          <h3>Add Source</h3>
          <button type="button" className="source-preview-close" onClick={onClose}>
            &#x2715;
          </button>
        </div>

        {mode === 'root' && (
          <div className="source-add-root">
            <div
              className={`source-drop-zone${dragOver ? ' is-dragover' : ''}`}
              onClick={() => void handleBrowse()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void handleBrowse(); }}
            >
              <UploadIcon />
              <div className="source-drop-title">Drop files or click to browse</div>
              <div className="source-drop-desc">
                PDF, Markdown, text — digested into summaries.
                <br />
                Code &amp; data (.py, .csv, .json, .tsv) — added verbatim, read on demand.
              </div>
            </div>
            <div className="source-add-alt-actions">
              <button type="button" className="source-alt-btn" onClick={() => setMode('paste')}>
                <PasteIcon />
                <span>Paste text</span>
              </button>
              <button type="button" className="source-alt-btn" onClick={() => setMode('link')}>
                <LinkIcon />
                <span>From link</span>
              </button>
            </div>
          </div>
        )}

        {mode === 'paste' && (
          <PasteForm
            onDone={() => { onDone(); onClose(); }}
            onIngesting={onIngesting}
            onBack={() => setMode('root')}
          />
        )}

        {mode === 'link' && (
          <LinkForm
            onDone={() => { onDone(); onClose(); }}
            onIngesting={onIngesting}
            onBack={() => setMode('root')}
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

function LinkForm({
  onDone,
  onIngesting,
  onBack,
}: {
  onDone: () => void;
  onIngesting: () => void;
  onBack: () => void;
}): JSX.Element {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    onIngesting();
    try {
      await bridge.sources.ingestLink(trimmed);
      onDone();
    } catch (err) {
      console.error('Link ingestion failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch link.');
      onDone();
    }
  }, [url, onDone, onIngesting]);

  return (
    <div className="source-paste-form">
      <input
        ref={inputRef}
        type="url"
        className="source-paste-title"
        placeholder="https://example.com/article"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
      />
      <div className="source-link-hint">
        We fetch the page, strip nav/ads, and digest it into a source — just like a pasted article.
      </div>
      {error && <div className="source-link-error">{error}</div>}
      <div className="source-paste-actions">
        <button
          type="button"
          className="source-paste-submit"
          onClick={() => void handleSubmit()}
          disabled={!url.trim()}
        >
          Fetch &amp; Add
        </button>
        <button type="button" className="source-option-cancel" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
