import { defineConfig } from 'vitest/config';

/** Unit tests: no database. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.int.test.ts'],
    testTimeout: 60_000,
  },
});
