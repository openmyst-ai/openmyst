import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import { getStatus, refreshMe } from '../features/me';

export function registerMeIpc(): void {
  ipcMain.handle(IpcChannels.Me.Get, () => getStatus());
  ipcMain.handle(IpcChannels.Me.Refresh, () => refreshMe({ force: true }));
}
