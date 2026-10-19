import { defineConfig } from 'vitest/config';

/** Unit tests: the files of infra/ and the host scripts with fake commands. No container. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.int.test.ts'],
    testTimeout: 30_000,
  },
});
