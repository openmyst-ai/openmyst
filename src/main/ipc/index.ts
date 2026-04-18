import { registerAuthIpc } from './auth';
import { registerMeIpc } from './me';
import { registerSettingsIpc } from './settings';
import { registerProjectsIpc } from './projects';
import { registerDocumentsIpc } from './documents';
import { registerChatIpc } from './chat';
import { registerCommentsIpc } from './comments';
import { registerPendingEditsIpc } from './pendingEdits';
import { registerSourcesIpc } from './sources';
import { registerWikiIpc } from './wiki';
import { registerBugReportIpc } from './bugReport';
import { registerDeepPlanIpc } from './deepPlan';
import { registerDeepSearchIpc } from './deepSearch';
import { registerUpdaterIpc } from './updater';

/**
 * IPC registration entry point. Each feature owns one file under ipc/ that
 * registers its own ipcMain handlers. Add a new feature → add a new file →
 * call its register*() here. That's the whole pattern.
 *
 * No business logic lives in ipc/ — these files are pure adapters: validate
 * input shape, hand off to the feature module, return the result. If you
 * find yourself wanting to put logic here, push it into the feature instead.
 */
export function registerIpcHandlers(): void {
  registerAuthIpc();
  registerMeIpc();
  registerSettingsIpc();
  registerProjectsIpc();
  registerDocumentsIpc();
  registerChatIpc();
  registerCommentsIpc();
  registerPendingEditsIpc();
  registerSourcesIpc();
  registerWikiIpc();
  registerBugReportIpc();
  registerDeepPlanIpc();
  registerDeepSearchIpc();
  registerUpdaterIpc();
}
