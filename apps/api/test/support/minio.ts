import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/**
 * MinIO for the integration tests of the inbound media (conversations slice). The same image as
 * `infra/compose/compose.dev.yml` (MinIO stopped its Docker Hub images; `pgsty/minio` is a community build).
 * Random host port, never a fixed port. Pass `env` to `TestHarness.start({ env })`.
 */
export const MINIO_IMAGE = 'pgsty/minio:RELEASE.2026-08-04T00-00-00Z';

const ACCESS_KEY = 'minio-test-access';
const SECRET_KEY = 'minio-test-secret-0123456789';

export interface TestMinio {
  env: Record<string, string>;
  bucket: string;
  client: S3Client;
  stop(): Promise<void>;
}

export async function startMinio(bucket = 'botcenter-media'): Promise<TestMinio> {
  const container: StartedTestContainer = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return {
    bucket,
    client,
    env: {
      S3_ENDPOINT: endpoint,
      S3_REGION: 'us-east-1',
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: SECRET_KEY,
      S3_FORCE_PATH_STYLE: 'true',
    },
    async stop() {
      client.destroy();
      await container.stop();
    },
  };
}
