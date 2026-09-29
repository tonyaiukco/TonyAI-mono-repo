import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Integration specs need a real PostgreSQL and run only through
    // `vitest.int.config.ts` (`pnpm --filter @tonyai/api test:int`).
    exclude: [...configDefaults.exclude, '**/*.int.spec.ts'],
    // These are pure-logic unit tests with a mocked PrismaService — no DB, no network.
    // Keep them deterministic and fast.
    clearMocks: true,
  },
});
