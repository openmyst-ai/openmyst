import { useMemo } from 'react';
import { useSourcePreview } from '../store/sourcePreview';
import { renderMarkdown } from '../utils/markdown';

export function SourcePreviewPopup(): JSX.Element | null {
  const { source, close } = useSourcePreview();
  const html = useMemo(
    () => (source ? renderMarkdown(source.summary) : ''),
    [source],
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
