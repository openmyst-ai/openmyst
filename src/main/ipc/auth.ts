import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import { getStatus, pasteToken, signIn, signOut } from '../features/auth';

export function registerAuthIpc(): void {
  ipcMain.handle(IpcChannels.Auth.Status, () => getStatus());

  ipcMain.handle(IpcChannels.Auth.SignIn, () => signIn());

  ipcMain.handle(IpcChannels.Auth.PasteToken, async (_event, token: unknown) => {
    if (typeof token !== 'string') throw new Error('Token must be a string.');
    await pasteToken(token);
  });

  ipcMain.handle(IpcChannels.Auth.SignOut, () => signOut());
}
