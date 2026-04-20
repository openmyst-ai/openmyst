import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
  // Mirror the compile-time define in electron.vite.config.ts so tests
  // that transitively import `src/shared/flags.ts` don't blow up on the
  // undefined constant. Value doesn't matter for unit tests — no code
  // path under test branches on it.
  define: {
    __USE_OPENMYST__: JSON.stringify(true),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
