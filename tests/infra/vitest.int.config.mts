import { defineConfig } from 'vitest/config';

/** Integration tests: PostgreSQL and Caddy containers (Testcontainers, random ports). */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
