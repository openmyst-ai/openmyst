import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import {
  closeProject,
  createNewProject,
  createProjectByName,
  ensureWorkspaceRoot,
  getCurrentProject,
  listWorkspaceProjects,
  openProject,
  openProjectByPath,
  pickWorkspaceRoot,
} from '../features/projects';
import { getSettings, getWorkspaceRoot } from '../features/settings';

export function registerProjectsIpc(): void {
  ipcMain.handle(IpcChannels.Projects.CreateNew, () => createNewProject());
  ipcMain.handle(IpcChannels.Projects.Open, () => openProject());
  ipcMain.handle(IpcChannels.Projects.GetCurrent, () => getCurrentProject());
  ipcMain.handle(IpcChannels.Projects.Close, () => {
    closeProject();
  });
  ipcMain.handle(IpcChannels.Projects.ListRecent, async () => {
    const s = await getSettings();
    return s.recentProjects;
  });
  ipcMain.handle(
    IpcChannels.Projects.CreateByName,
    (_event, input: { name: string; parentDir?: string }) => createProjectByName(input),
  );
  ipcMain.handle(IpcChannels.Projects.OpenByPath, (_event, path: string) =>
    openProjectByPath(path),
  );

  ipcMain.handle(IpcChannels.Workspace.GetRoot, () => getWorkspaceRoot());
  ipcMain.handle(IpcChannels.Workspace.PickRoot, () => pickWorkspaceRoot());
  ipcMain.handle(IpcChannels.Workspace.SetRoot, (_event, path: string) =>
    ensureWorkspaceRoot(path),
  );
  ipcMain.handle(IpcChannels.Workspace.ListProjects, () => listWorkspaceProjects());
}
