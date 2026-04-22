import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import {
  clearJinaKey,
  clearOpenRouterKey,
  getSettings,
  setChairModel,
  setDefaultModel,
  setDeepPlanModel,
  setDraftModel,
  setJinaKey,
  setOpenRouterKey,
  setSummaryModel,
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

  ipcMain.handle(IpcChannels.Settings.SetJinaKey, async (_event, key: unknown) => {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new Error('Jina API key must be a non-empty string.');
    }
    await setJinaKey(key.trim());
  });

  ipcMain.handle(IpcChannels.Settings.HasJinaKey, async () => {
    const s = await getSettings();
    return s.hasJinaKey;
  });

  ipcMain.handle(IpcChannels.Settings.ClearJinaKey, () => clearJinaKey());

  ipcMain.handle(IpcChannels.Settings.SetDeepPlanModel, async (_event, model: unknown) => {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error('Model id must be a non-empty string.');
    }
    await setDeepPlanModel(model.trim());
  });

  ipcMain.handle(IpcChannels.Settings.SetChairModel, async (_event, model: unknown) => {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error('Model id must be a non-empty string.');
    }
    await setChairModel(model.trim());
  });

  ipcMain.handle(IpcChannels.Settings.SetDraftModel, async (_event, model: unknown) => {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error('Model id must be a non-empty string.');
    }
    await setDraftModel(model.trim());
  });

  ipcMain.handle(IpcChannels.Settings.SetSummaryModel, async (_event, model: unknown) => {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error('Model id must be a non-empty string.');
    }
    await setSummaryModel(model.trim());
  });
}
