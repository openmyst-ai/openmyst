import { create } from 'zustand';
import type { AppSettings, ProjectMeta, WorkspaceProject } from '@shared/types';
import { bridge } from '../api/bridge';

interface AppState {
  project: ProjectMeta | null;
  settings: AppSettings | null;
  settingsOpen: boolean;
  loading: boolean;
  error: string | null;
  workspaceProjects: WorkspaceProject[];
  workspaceLoading: boolean;

  init: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  dismissError: () => void;
  createNewProject: () => Promise<void>;
  openExistingProject: () => Promise<void>;
  closeProject: () => Promise<void>;

  refreshWorkspaceProjects: () => Promise<void>;
  setWorkspaceRoot: (path: string) => Promise<void>;
  pickWorkspaceRoot: () => Promise<void>;
  createProjectByName: (input: { name: string; parentDir?: string }) => Promise<void>;
  openProjectByPath: (path: string) => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  project: null,
  settings: null,
  settingsOpen: false,
  loading: false,
  error: null,
  workspaceProjects: [],
  workspaceLoading: false,

  init: async () => {
    set({ loading: true, error: null });
    try {
      const [settings, project] = await Promise.all([
        bridge.settings.get(),
        bridge.projects.getCurrent(),
      ]);
      set({ settings, project, loading: false });
      if (settings.workspaceRoot && !project) {
        void get().refreshWorkspaceProjects();
      }
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  refreshSettings: async () => {
    const settings = await bridge.settings.get();
    set({ settings });
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  dismissError: () => set({ error: null }),

  createNewProject: async () => {
    set({ loading: true, error: null });
    try {
      const result = await bridge.projects.createNew();
      if (result.ok) {
        set({ project: result.value });
        await get().refreshSettings();
      } else if (result.error !== 'cancelled') {
        set({ error: result.error });
      }
    } catch (err) {
      console.error('createNewProject failed', err);
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  openExistingProject: async () => {
    set({ loading: true, error: null });
    try {
      const result = await bridge.projects.open();
      if (result.ok) {
        set({ project: result.value });
        await get().refreshSettings();
      } else if (result.error !== 'cancelled') {
        set({ error: result.error });
      }
    } catch (err) {
      console.error('openExistingProject failed', err);
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  closeProject: async () => {
    set({ loading: true, error: null });
    try {
      await bridge.projects.close();
      set({ project: null });
      if (get().settings?.workspaceRoot) {
        void get().refreshWorkspaceProjects();
      }
    } catch (err) {
      console.error('closeProject failed', err);
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  refreshWorkspaceProjects: async () => {
    set({ workspaceLoading: true });
    try {
      const projects = await bridge.workspace.listProjects();
      set({ workspaceProjects: projects });
    } catch (err) {
      console.error('refreshWorkspaceProjects failed', err);
    } finally {
      set({ workspaceLoading: false });
    }
  },

  setWorkspaceRoot: async (path) => {
    set({ loading: true, error: null });
    try {
      await bridge.workspace.setRoot(path);
      await get().refreshSettings();
      await get().refreshWorkspaceProjects();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  pickWorkspaceRoot: async () => {
    set({ loading: true, error: null });
    try {
      const picked = await bridge.workspace.pickRoot();
      if (picked) {
        await get().refreshSettings();
        await get().refreshWorkspaceProjects();
      }
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  createProjectByName: async (input) => {
    set({ loading: true, error: null });
    try {
      const result = await bridge.projects.createByName(input);
      if (result.ok) {
        set({ project: result.value });
        await get().refreshSettings();
      } else {
        set({ error: result.error });
      }
    } catch (err) {
      console.error('createProjectByName failed', err);
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  openProjectByPath: async (path) => {
    set({ loading: true, error: null });
    try {
      const result = await bridge.projects.openByPath(path);
      if (result.ok) {
        set({ project: result.value });
        await get().refreshSettings();
      } else {
        set({ error: result.error });
      }
    } catch (err) {
      console.error('openProjectByPath failed', err);
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },
}));
