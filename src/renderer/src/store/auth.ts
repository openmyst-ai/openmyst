import { create } from 'zustand';
import { USE_OPENMYST } from '@shared/flags';
import { bridge } from '../api/bridge';

/**
 * Signed-in state mirrored from the main process. In BYOK dev builds we
 * short-circuit `signedIn` to true so the renderer's auth gate is a no-op.
 */
interface AuthState {
  signedIn: boolean;
  loading: boolean;
  error: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  pasteToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  dismissError: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  // In BYOK dev mode there is no login — treat every user as signed in so the
  // gate falls through.
  signedIn: !USE_OPENMYST,
  loading: false,
  error: null,

  init: async () => {
    if (!USE_OPENMYST) return;
    const status = await bridge.auth.status();
    set({ signedIn: status.signedIn });
    bridge.auth.onChanged(() => {
      void (async () => {
        const s = await bridge.auth.status();
        set({ signedIn: s.signedIn });
      })();
    });
  },

  refresh: async () => {
    if (!USE_OPENMYST) return;
    const status = await bridge.auth.status();
    set({ signedIn: status.signedIn });
  },

  signIn: async () => {
    set({ loading: true, error: null });
    try {
      await bridge.auth.signIn();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  pasteToken: async (token) => {
    set({ loading: true, error: null });
    try {
      await bridge.auth.pasteToken(token);
      const status = await bridge.auth.status();
      set({ signedIn: status.signedIn });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  signOut: async () => {
    set({ loading: true, error: null });
    try {
      await bridge.auth.signOut();
      set({ signedIn: false });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  dismissError: () => set({ error: null }),
}));
