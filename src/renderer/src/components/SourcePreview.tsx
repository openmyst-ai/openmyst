import { useCallback, useMemo } from 'react';
import { bridge } from '../api/bridge';
import { useSourcePreview } from '../store/sourcePreview';
import { renderMarkdown } from '../utils/markdown';

export function SourcePreviewPopup(): JSX.Element | null {
  const { source, open, close } = useSourcePreview();
  const html = useMemo(
    () => (source ? renderMarkdown(source.summary) : ''),
    [source],
  );

  // Intercept wikilinks (`[Name](slug.md)`) so clicking one swaps the
  // preview to that source instead of letting Electron route the anchor
  // through setWindowOpenHandler → shell.openExternal, which opens the
  // link in the system browser sliding behind the app.
  const handleBodyClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();
      const raw =
        anchor.getAttribute('href') ?? (anchor as HTMLAnchorElement).href ?? '';
      const lastSeg = raw.split(/[?#]/)[0]!.split('/').pop() ?? '';
      const match = /^(.+)\.md$/i.exec(lastSeg);
      if (!match) return;
      const slug = match[1]!;
      void bridge.sources.list().then((all) => {
        const full = all.find((s) => s.slug === slug);
        if (full) open(full);
      });
    },
    [open],
  );

  if (!source) return null;

  return (
    <div className="source-preview-overlay" onClick={close}>
      <div className="source-preview-popup" onClick={(e) => e.stopPropagation()}>
        <div className="source-preview-header">
          <h3>{source.name}</h3>
          <button type="button" className="source-preview-close" onClick={close}>
            &#x2715;
          </button>
        </div>
        <div
          className="source-preview-body dp-md"
          onClick={handleBodyClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {source.sourcePath && (
          <div className="source-preview-path">{source.sourcePath}</div>
        )}
        {!source.sourcePath && source.type === 'pasted' && (
          <div className="source-preview-path">Pasted text</div>
        )}
      </div>
    </div>
  );
}
