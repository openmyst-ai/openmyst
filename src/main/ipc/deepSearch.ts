import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import { addHint, getStatus, resetSearch, startSearch, stopSearch } from '../features/deepSearch';

export function registerDeepSearchIpc(): void {
  ipcMain.handle(IpcChannels.DeepSearch.Status, async () => getStatus());

  ipcMain.handle(IpcChannels.DeepSearch.Start, async (_event, task: unknown) => {
    if (typeof task !== 'string' || task.trim().length === 0) {
      throw new Error('Research task is required.');
    }
    return startSearch(task);
  });

  ipcMain.handle(IpcChannels.DeepSearch.Stop, async () => stopSearch());

  ipcMain.handle(IpcChannels.DeepSearch.Reset, async () => resetSearch());

  ipcMain.handle(IpcChannels.DeepSearch.AddHint, async (_event, hint: unknown) => {
    if (typeof hint !== 'string') throw new Error('Hint must be a string.');
    return addHint(hint);
  });
}
