import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import {
  deleteSource,
  ingestLink,
  ingestSources,
  ingestText,
  listSources,
  pickSourceFiles,
  readSource,
} from '../features/sources';

export function registerSourcesIpc(): void {
  ipcMain.handle(IpcChannels.Sources.Ingest, async (_event, filePaths: unknown) => {
    if (!Array.isArray(filePaths) || filePaths.some((p) => typeof p !== 'string')) {
      throw new Error('File paths must be an array of strings.');
    }
    return ingestSources(filePaths as string[]);
  });
  ipcMain.handle(IpcChannels.Sources.IngestText, async (_event, text: unknown, title: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Text must be a non-empty string.');
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('Title must be a non-empty string.');
    }
    return ingestText(text.trim(), title.trim());
  });
  ipcMain.handle(IpcChannels.Sources.IngestLink, async (_event, url: unknown) => {
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new Error('URL must be a non-empty string.');
    }
    return ingestLink(url.trim());
  });
  ipcMain.handle(IpcChannels.Sources.PickFiles, () => pickSourceFiles());
  ipcMain.handle(IpcChannels.Sources.List, () => listSources());
  ipcMain.handle(IpcChannels.Sources.Read, (_event, slug: unknown) => {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new Error('Source slug must be a non-empty string.');
    }
    return readSource(slug.trim());
  });
  ipcMain.handle(IpcChannels.Sources.Delete, async (_event, slug: unknown) => {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new Error('Source slug must be a non-empty string.');
    }
    await deleteSource(slug.trim());
  });
}
