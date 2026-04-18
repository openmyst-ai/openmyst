import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import {
  checkForUpdates,
  downloadAndInstall,
  getUpdateStatus,
} from '../features/updater';

export function registerUpdaterIpc(): void {
  ipcMain.handle(IpcChannels.Updater.GetStatus, () => getUpdateStatus());
  ipcMain.handle(IpcChannels.Updater.Check, () => checkForUpdates());
  ipcMain.handle(IpcChannels.Updater.DownloadAndInstall, () => downloadAndInstall());
}
