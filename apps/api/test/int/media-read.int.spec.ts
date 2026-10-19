import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tenant } from '../../src/generated/prisma/client';
import { MessagesApiModule } from '../../src/messages/messages.module';
import { TestHarness } from '../support/harness';

/**
 * `GET /v1/media/{id}`: a fresh signed URL for a media file of the tenant. The URL of an inbound file in
 * a webhook event expires after 1 h, before the late retries of the webhook.
 */
let h: TestHarness;

beforeAll(async () => {
  h = await TestHarness.start({ modules: [MessagesApiModule], minio: true });
});

afterAll(async () => {
  await h?.close();
});

async function inboundFile(tenant: Tenant, instanceId: string, bytes = Buffer.from('JPEG')) {
  const id = randomUUID();
  const key = `tenants/${tenant.id}/inbound/${id}`;
  const s3 = new S3Client({
    endpoint: h.minio.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: h.minio.accessKeyId, secretAccessKey: h.minio.secretAccessKey },
  });
  await s3.send(new PutObjectCommand({ Bucket: h.minio.bucket, Key: key, Body: bytes }));
  s3.destroy();
  await h.prisma.message.create({
    data: {
      tenantId: tenant.id,
      instanceId,
      direction: 'inbound',
      type: 'media',
      status: 'received',
      contact: '5511987654321',
      content: { type: 'media', media_type: 'image', media_status: 'stored', media_id: id },
    },
  });
  return h.prisma.mediaObject.create({
    data: {
      id,
      tenantId: tenant.id,
      key,
      contentType: 'image/jpeg',
      sizeBytes: bytes.length,
      direction: 'inbound',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

function read(key: string, id: string) {
  return h.inject({ method: 'GET', url: `/v1/media/${id}`, headers: h.bearer(key) });
}

describe('GET /v1/media/{id}', () => {
  it('gives a fresh signed URL of the file', async () => {
    const tenant = await h.createTenant();
    const instance = await h.createInstance(tenant.id);
    const media = await inboundFile(tenant, instance.id);
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read'] });
    const response = await read(key, media.id);
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, string | number | null>;
    expect(body).toMatchObject({
      media_id: media.id,
      direction: 'inbound',
      mime_type: 'image/jpeg',
      size_bytes: 4,
      file_name: null,
    });
    expect(new Date(body['expires_at'] as string).getTime()).toBeGreaterThan(Date.now() + 800_000);
    const file = await fetch(body['url'] as string);
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('JPEG');
  });

  it('hides a file of another tenant, an expired file, and a file of an instance outside the key list', async () => {
    const tenant = await h.createTenant();
    const allowed = await h.createInstance(tenant.id);
    const other = await h.createInstance(tenant.id);
    const media = await inboundFile(tenant, other.id);
    const limited = await h.createApiKey({
      tenantId: tenant.id,
      scopes: ['events:read'],
      instanceIds: [allowed.id],
    });
    expect((await read(limited.key, media.id)).statusCode).toBe(404);

    const stranger = await h.createTenant();
    const strangerKey = await h.createApiKey({ tenantId: stranger.id, scopes: ['events:read'] });
    expect((await read(strangerKey.key, media.id)).statusCode).toBe(404);

    const full = await h.createApiKey({ tenantId: tenant.id, scopes: ['events:read'] });
    await h.prisma.mediaObject.update({
      where: { id: media.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await read(full.key, media.id)).statusCode).toBe(404);
  });

  it('needs the scope events:read', async () => {
    const tenant = await h.createTenant();
    const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });
    expect((await read(key, randomUUID())).statusCode).toBe(403);
  });
});
