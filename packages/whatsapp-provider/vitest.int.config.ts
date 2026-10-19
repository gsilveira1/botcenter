import { defineConfig } from 'vitest/config';

/** Integration tests: the real Evolution API image with PostgreSQL and Redis (Testcontainers). */
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
