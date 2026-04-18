import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Build-time flag: when true, the app runs in "managed" (production) mode and
 * routes all LLM + search traffic through openmyst.ai using a signed-in
 * token. When false, the app runs in "BYOK" (dev) mode and talks directly to
 * OpenRouter/Jina with user-supplied keys from Settings.
 *
 * Set via env: `USE_OPENMYST=1 npm run dev` (or `dev:prod`, `dist:prod`
 * scripts in package.json). Defaults to false so `npm run dev` keeps the
 * BYOK flow developers use for testing. Must be a literal boolean in Vite
 * define so Rollup can dead-code-eliminate the unused branch.
 */
const USE_OPENMYST =
  process.env['USE_OPENMYST'] === '1' || process.env['USE_OPENMYST'] === 'true';

const defineConsts = {
  __USE_OPENMYST__: JSON.stringify(USE_OPENMYST),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    define: defineConsts,
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    define: defineConsts,
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    define: defineConsts,
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
