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
import { TutorialOverlay } from './tutorial/TutorialOverlay';
import { EDITOR_TUTORIAL } from './tutorial/steps';
import { useTutorial } from './tutorial/useTutorial';
import logoUrl from '../assets/logo.svg';

export function Layout(): JSX.Element {
  const { project, openSettings, closeProject } = useApp();
  const loadFiles = useDocuments((s) => s.loadFiles);
  const openDeepWiki = useDeepSearch((s) => s.open);

  const tutorial = useTutorial('editor');

  useEffect(() => {
    loadFiles().catch(console.error);
  }, [loadFiles, project]);

  return (
    <div className="layout">
      <header className="titlebar">
        <div className="titlebar-left">
          <img src={logoUrl} className="app-logo" alt="" aria-hidden="true" />
          <span className="app-name">Open Myst</span>
          {project && <span className="project-name">· {project.name}</span>}
        </div>
        <div className="titlebar-right">
          <button
            type="button"
            className="titlebar-btn"
            data-tutorial="ed-deep-wiki"
            onClick={openDeepWiki}
          >
            Deep Wiki
          </button>
          <button
            type="button"
            className="titlebar-btn"
            data-tutorial="ed-settings"
            onClick={openSettings}
          >
            Settings
          </button>
          <button type="button" className="titlebar-btn" onClick={() => void closeProject()}>
            Close project
          </button>
        </div>
      </header>
      <main className="panes">
        <aside className="pane pane-left">
          <div data-tutorial="ed-sources">
            <SourcesPanel />
          </div>
          <div data-tutorial="ed-files">
            <DocumentFiles />
          </div>
          <div data-tutorial="ed-toc">
            <TableOfContents />
          </div>
        </aside>
        <section className="pane pane-center" data-tutorial="ed-doc">
          <DocumentPanel />
        </section>
        <aside className="pane pane-right" data-tutorial="ed-chat">
          <ChatPanel />
        </aside>
      </main>
      <SourcePreviewPopup />
      <DeepSearchModal />
      {tutorial.shouldShow && (
        <TutorialOverlay
          steps={EDITOR_TUTORIAL}
          onDone={tutorial.markDone}
          onSkip={tutorial.markDone}
        />
      )}
    </div>
  );
}
