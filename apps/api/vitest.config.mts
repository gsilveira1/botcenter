import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Unit tests: fast, no database, no Redis. SWC compiles the decorators with metadata. */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    env: { LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent' },
  },
});
