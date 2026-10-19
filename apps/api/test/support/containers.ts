import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';

const run = promisify(execFile);

export const API_DIR = path.resolve(__dirname, '..', '..');
const PRISMA_BIN = path.join(API_DIR, 'node_modules', '.bin', 'prisma');
const PRISMA_CONFIG = path.resolve(API_DIR, '..', '..', 'prisma', 'prisma.config.ts');

export interface TestContainers {
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

/** Applies the SQL migrations of `prisma/` with `prisma migrate deploy`. */
export async function migrate(databaseUrl: string): Promise<void> {
  try {
    await run(PRISMA_BIN, ['migrate', 'deploy', '--config', PRISMA_CONFIG], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL_MIGRATE: databaseUrl },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(
      `prisma migrate deploy failed:\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Starts PostgreSQL 16 and Redis 7 (random host ports, never fixed) and applies the migrations.
 * Call it once in `beforeAll` of a test file.
 */
export async function startContainers(): Promise<TestContainers> {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const databaseUrl = (postgres as StartedPostgreSqlContainer).getConnectionUri();
  await migrate(databaseUrl);
  return {
    databaseUrl,
    redisUrl: (redis as StartedRedisContainer).getConnectionUrl(),
    async stop() {
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
}
