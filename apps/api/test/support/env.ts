import { loadEnv } from '../../src/config/env';
import type { AppEnv } from '../../src/config/env';

/** A complete, valid environment for unit tests (no connection opens with it). */
export const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/botcenter',
  REDIS_URL: 'redis://localhost:6379/0',
  API_KEY_PEPPER: 'p'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  EVOLUTION_URL: 'http://evolution:8080',
  EVOLUTION_API_KEY: 'key',
  EVOLUTION_WEBHOOK_SECRET: 's'.repeat(32),
  INTERNAL_WEBHOOK_BASE_URL: 'http://api:3000',
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET: 'media',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
};

export function testEnv(overrides: Record<string, string> = {}): AppEnv {
  return loadEnv({ ...VALID_ENV, ...overrides });
}
