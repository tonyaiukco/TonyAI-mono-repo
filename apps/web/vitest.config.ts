import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The first unit-test setup in `apps/web`.
 *
 * Until now this package's `test` script was a single assertion about
 * `next.config.mjs`, so `pnpm test` ran no unit tests here at all — and
 * `lib/dashboard-view.ts`, which decides what every dashboard tile claims, was
 * covered only by E2E that CI does not run.
 *
 * Node environment on purpose: what needs covering is the pure mapping from the
 * API's DTO to what the screen asserts. Component rendering would need jsdom
 * plus a testing-library, which is a bigger decision than this change.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.spec.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
