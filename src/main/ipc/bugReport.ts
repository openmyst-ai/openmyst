import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import { previewBugReport, recordRendererLog, submitBugReport } from '../features/bugReport';

function parseInput(input: unknown): { title: string; description: string } {
  if (!input || typeof input !== 'object') {
    throw new Error('Bug report input must be an object.');
  }
  const { title, description } = input as { title?: unknown; description?: unknown };
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('Bug report title is required.');
  }
  if (typeof description !== 'string') {
    throw new Error('Bug report description must be a string.');
  }
  return { title, description };
}

export function registerBugReportIpc(): void {
  ipcMain.handle(IpcChannels.BugReport.Preview, async (_event, input: unknown) => {
    const parsed = parseInput(input);
    return previewBugReport(parsed);
  });

  ipcMain.handle(IpcChannels.BugReport.Submit, async (_event, input: unknown) => {
    const parsed = parseInput(input);
    return submitBugReport(parsed);
  });

  ipcMain.handle(
    IpcChannels.BugReport.RendererLog,
    (_event, scope: unknown, event: unknown, message: unknown) => {
      if (typeof scope !== 'string') return;
      if (typeof event !== 'string') return;
      if (typeof message !== 'string') return;
      recordRendererLog(scope, event, message);
    },
  );
}
