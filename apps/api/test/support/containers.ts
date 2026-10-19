import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait } from 'testcontainers';

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

/** MinIO stopped its Docker Hub images in 2025. `pgsty/minio` is a community build of the same server. */
export const MINIO_IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z';

export interface TestMinio {
  /** The S3 endpoint on the host (random port). */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The S3 environment of the API for this MinIO (path-style URLs). */
  env: Record<string, string>;
  stop(): Promise<void>;
}

/** Starts MinIO (random host port) and makes one private bucket. */
export async function startMinio(bucket = 'botcenter-media'): Promise<TestMinio> {
  const accessKeyId = 'minio-test';
  const secretAccessKey = 'minio-test-secret';
  const container = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const region = 'us-east-1';
  const s3 = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } finally {
    s3.destroy();
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    env: {
      S3_ENDPOINT: endpoint,
      S3_REGION: region,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
    },
    async stop() {
      await container.stop();
    },
  };
}
