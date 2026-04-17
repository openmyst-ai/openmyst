import { create } from 'zustand';
import { USE_OPENMYST } from '@shared/flags';
import type { MeStatus } from '@shared/types';
import { bridge } from '../api/bridge';

/**
 * Mirror of the main process `/me` snapshot. Drives the quota pills,
 * approaching-limit banner, and the current-model display.
 *
 * In BYOK dev mode the store is inert: `snapshot` stays null and the UI
 * components that read it render nothing.
 */
interface MeStoreState extends MeStatus {
  init: () => Promise<void>;
  refresh: () => Promise<void>;
}

const INITIAL: MeStatus = {
  snapshot: null,
  loading: false,
  error: null,
  offline: false,
};

export const useMe = create<MeStoreState>((set) => ({
  ...INITIAL,

  init: async () => {
    if (!USE_OPENMYST) return;
    try {
      const status = await bridge.me.get();
      set(status);
    } catch {
      // Bridge may not be ready on very early calls — the onChanged listener
      // below will catch us up once the main process broadcasts.
    }
    bridge.me.onChanged(() => {
      void (async () => {
        const s = await bridge.me.get();
        set(s);
      })();
    });
    bridge.auth.onChanged(() => {
      void (async () => {
        // On sign-in / sign-out, ask the main process for a fresh pull —
        // the /me cache on the main side keys off the token.
        await bridge.me.refresh().catch(() => {});
        const s = await bridge.me.get();
        set(s);
      })();
    });
  },

  refresh: async () => {
    if (!USE_OPENMYST) return;
    const status = await bridge.me.refresh();
    set(status);
  },
}));
