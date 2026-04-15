import { useEffect } from 'react';
import { useApp } from '../store/app';
import { useDocuments } from '../store/documents';
import { useDeepSearch } from '../store/deepSearch';
import { SourcesPanel } from './SourcesPanel';
import { DocumentFiles } from './DocumentFiles';
import { DocumentPanel } from './DocumentPanel';
import { ChatPanel } from './ChatPanel';
import { TableOfContents } from './TableOfContents';
import { SourcePreviewPopup } from './SourcePreview';
import { DeepSearchModal } from './research/DeepSearchModal';

export function Layout(): JSX.Element {
  const { project, openSettings, closeProject } = useApp();
  const loadFiles = useDocuments((s) => s.loadFiles);
  const openDeepSearch = useDeepSearch((s) => s.open);

  useEffect(() => {
    loadFiles().catch(console.error);
  }, [loadFiles, project]);

  return (
    <div className="layout">
      <header className="titlebar">
        <div className="titlebar-left">
          <span className="app-name">Open Myst</span>
          {project && <span className="project-name">· {project.name}</span>}
        </div>
        <div className="titlebar-right">
          <button type="button" className="link" onClick={openDeepSearch}>
            Deep Search
          </button>
          <button type="button" className="link" onClick={openSettings}>
            Settings
          </button>
          <button type="button" className="link" onClick={() => void closeProject()}>
            Close project
          </button>
        </div>
      </header>
      <main className="panes">
        <aside className="pane pane-left">
          <SourcesPanel />
          <DocumentFiles />
          <TableOfContents />
        </aside>
        <section className="pane pane-center">
          <DocumentPanel />
        </section>
        <aside className="pane pane-right">
          <ChatPanel />
        </aside>
      </main>
      <SourcePreviewPopup />
      <DeepSearchModal />
    </div>
  );
}
