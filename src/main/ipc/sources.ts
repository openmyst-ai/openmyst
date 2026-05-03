import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import {
  deleteSource,
  ingestLink,
  ingestSources,
  ingestText,
  listAllAnchors,
  listSources,
  pickSourceFiles,
  readSource,
  setSourceRole,
} from '../features/sources';
import { readAnchor } from '../features/sources/lookup';

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
  ipcMain.handle(IpcChannels.Sources.ListAllAnchors, () => listAllAnchors());
  ipcMain.handle(IpcChannels.Sources.Read, (_event, slug: unknown) => {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new Error('Source slug must be a non-empty string.');
    }
    return readSource(slug.trim());
  });
  ipcMain.handle(
    IpcChannels.Sources.LookupAnchor,
    async (_event, slug: unknown, anchorId: unknown) => {
      if (typeof slug !== 'string' || slug.trim().length === 0) {
        throw new Error('Source slug must be a non-empty string.');
      }
      if (typeof anchorId !== 'string' || anchorId.trim().length === 0) {
        throw new Error('Anchor id must be a non-empty string.');
      }
      return readAnchor(slug.trim(), anchorId.trim());
    },
  );
  ipcMain.handle(IpcChannels.Sources.Delete, async (_event, slug: unknown) => {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new Error('Source slug must be a non-empty string.');
    }
    await deleteSource(slug.trim());
  });
  ipcMain.handle(IpcChannels.Sources.SetRole, async (_event, slug: unknown, role: unknown) => {
    if (typeof slug !== 'string' || slug.trim().length === 0) {
      throw new Error('Source slug must be a non-empty string.');
    }
    if (role !== 'reference' && role !== 'guidance') {
      throw new Error('Role must be "reference" or "guidance".');
    }
    return setSourceRole(slug.trim(), role);
  });
}
