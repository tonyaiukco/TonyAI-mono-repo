import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // These are pure-logic unit tests with a mocked PrismaService — no DB, no network.
    // Keep them deterministic and fast.
    clearMocks: true,
  },
});
