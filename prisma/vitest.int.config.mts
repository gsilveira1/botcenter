import { defineConfig } from 'vitest/config';

/** Integration tests: a throwaway PostgreSQL 16 container (Testcontainers, random port). */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
