import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests: each test file starts its own PostgreSQL 16 and Redis 7 containers
 * (Testcontainers, random host ports) through `test/support/harness.ts`.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/int/**/*.int.spec.ts'],
    environment: 'node',
    env: { LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent' },
    testTimeout: 60_000,
    hookTimeout: 240_000,
    fileParallelism: true,
    maxWorkers: 4,
  },
});
