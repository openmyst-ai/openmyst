import { useCallback, useMemo } from 'react';
import type { SourceRole } from '@shared/types';
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

  const handleSetRole = useCallback(
    async (role: SourceRole) => {
      if (!source) return;
      const updated = await bridge.sources.setRole(source.slug, role);
      open(updated);
    },
    [source, open],
  );

  if (!source) return null;

  const role: SourceRole = source.role ?? 'reference';
  const isRaw = source.type === 'raw';

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
        {!isRaw && (
          <div className="source-role-toggle" role="group" aria-label="Source role">
            <span className="source-role-label">Role</span>
            <div className="source-role-buttons">
              <button
                type="button"
                className={`source-role-btn${role === 'reference' ? ' is-active' : ''}`}
                onClick={() => void handleSetRole('reference')}
              >
                Reference
              </button>
              <button
                type="button"
                className={`source-role-btn${role === 'guidance' ? ' is-active' : ''}`}
                onClick={() => void handleSetRole('guidance')}
              >
                Guidance
              </button>
            </div>
            <span className="source-role-hint">
              {role === 'reference'
                ? 'Cited inline + listed in references.'
                : 'Method/framework — informs how the draft is written, never cited.'}
            </span>
          </div>
        )}
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
