import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import {
  clearOpenRouterKey,
  clearTavilyKey,
  getSettings,
  setDefaultModel,
  setDeepPlanModel,
  setOpenRouterKey,
  setTavilyKey,
} from '../features/settings';

export function registerSettingsIpc(): void {
  ipcMain.handle(IpcChannels.Settings.Get, () => getSettings());

  ipcMain.handle(IpcChannels.Settings.SetOpenRouterKey, async (_event, key: unknown) => {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('API key must be a non-empty string.');
    }
    await setOpenRouterKey(key.trim());
  });

  ipcMain.handle(IpcChannels.Settings.HasOpenRouterKey, async () => {
    const s = await getSettings();
    return s.hasOpenRouterKey;
  });

  ipcMain.handle(IpcChannels.Settings.ClearOpenRouterKey, () => clearOpenRouterKey());

  ipcMain.handle(IpcChannels.Settings.SetDefaultModel, async (_event, model: unknown) => {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error('Model id must be a non-empty string.');
    }
    await setDefaultModel(model.trim());
  });

  ipcMain.handle(IpcChannels.Settings.SetTavilyKey, async (_event, key: unknown) => {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('Tavily API key must be a non-empty string.');
    }
    await setTavilyKey(key.trim());
  });

  ipcMain.handle(IpcChannels.Settings.HasTavilyKey, async () => {
    const s = await getSettings();
    return s.hasTavilyKey;
  });

  ipcMain.handle(IpcChannels.Settings.ClearTavilyKey, () => clearTavilyKey());

  ipcMain.handle(IpcChannels.Settings.SetDeepPlanModel, async (_event, model: unknown) => {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error('Model id must be a non-empty string.');
    }
    await setDeepPlanModel(model.trim());
  });
}
