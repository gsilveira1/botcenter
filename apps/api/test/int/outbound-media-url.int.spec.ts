import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExternalHttpClient } from '../../src/external-http/external-http.client';
import { DNS_RESOLVER, SsrfGuard } from '../../src/external-http/ssrf-guard';
import type { Instance, Tenant } from '../../src/generated/prisma/client';
import { MessagesApiModule, MessagesWorkerModule } from '../../src/messages/messages.module';
import { QueuesService } from '../../src/queues/queues.service';
import { TestHarness } from '../support/harness';
import { TestReceiver, respond, selfSignedCertificate } from '../support/receiver';
import { waitFor } from '../support/wait-for';
import { fakeDns } from '../support/webhooks';

/**
 * SEC-01: a client media URL never goes to Evolution. The worker downloads the file through the SSRF
 * guard (no redirects, size limit), stores it in the private bucket, and gives the provider a pre-signed
 * GET URL of the bucket. The file server is a local HTTPS receiver with a self-signed certificate; the
 * fake DNS maps `media.test` to it and `metadata.test` to the cloud metadata address.
 */
const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const PDF = Buffer.from('%PDF-1.4\n% a small test file\n');

let h: TestHarness;
let files: TestReceiver;

beforeAll(async () => {
  const tls = await selfSignedCertificate(['media.test']);
  files = await TestReceiver.start(tls);
  const dns = fakeDns({
    'media.test': [{ address: '127.0.0.1', family: 4 }],
    'metadata.test': [{ address: '169.254.169.254', family: 4 }],
  });
  h = await TestHarness.start({
    modules: [MessagesApiModule],
    minio: true,
    env: { EXTERNAL_HTTP_ALLOW_PRIVATE: 'true' },
    override: (builder) =>
      builder
        .overrideProvider(DNS_RESOLVER)
        .useValue(dns)
        .overrideProvider(ExternalHttpClient)
        .useFactory({
          factory: (guard: SsrfGuard) =>
            new ExternalHttpClient(guard, { maxResponseBytes: 1024 * 1024, ca: tls.cert }),
          inject: [SsrfGuard],
        }),
  });
  await h.startWorker([MessagesWorkerModule]);
});

afterAll(async () => {
  await h?.close();
  await files?.close();
});

interface Fixture {
  tenant: Tenant;
  instance: Instance;
  key: string;
}

async function fixture(): Promise<Fixture> {
  const tenant = await h.createTenant();
  const instance = await h.createInstance(tenant.id, {
    status: 'connected',
    firstConnectedAt: LONG_AGO,
    rateLimitPerMinute: 600,
  });
  await h.provider.createInstance({
    name: instance.providerName,
    webhookUrl: 'x',
    webhookSecret: 's',
  });
  h.provider.setState(instance.providerName, 'connected');
  const { key } = await h.createApiKey({ tenantId: tenant.id, scopes: ['messages:send'] });
  return { tenant, instance, key };
}

function fileUrl(name: string): string {
  return `https://media.test:${files.port}/${name}`;
}

function sendMedia(f: Fixture, url: string) {
  return h.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { ...h.bearer(f.key), 'content-type': 'application/json' },
    payload: JSON.stringify({
      instance_id: f.instance.id,
      to: '5511987654321',
      type: 'media',
      media_type: 'document',
      url,
      file_name: 'treino.pdf',
    }),
  });
}

async function finalStatus(id: string, timeoutMs = 15_000) {
  const queue = h.get(QueuesService).get('outbound');
  await waitFor(async () => {
    // Skip the backoff of a retry.
    const job = (await queue.getJob(id)) as Job | undefined;
    if ((await job?.getState()) === 'delayed') {
      await job?.promote().catch(() => undefined);
    }
    const row = await h.prisma.message.findUniqueOrThrow({ where: { id } });
    return row.status !== 'queued';
  }, timeoutMs);
  return h.prisma.message.findUniqueOrThrow({ where: { id } });
}

function requestsFor(name: string) {
  return files.requests.filter((request) => request.url === `/${name}`);
}

describe('outbound media URL (SEC-01)', () => {
  it('gives the provider a signed URL of the bucket, never the client URL', async () => {
    const f = await fixture();
    const name = `${randomUUID()}.pdf`;
    files.next(respond(200, PDF.toString('latin1'), { 'content-type': 'application/pdf' }));
    const response = await sendMedia(f, fileUrl(name));
    expect(response.statusCode).toBe(202);
    const row = await finalStatus(response.json().id as string);
    expect(row.status).toBe('sent');

    const [send] = h.provider.sentTo(f.instance.providerName);
    const content = send?.input.content as { url: string; mime_type?: string; file_name?: string };
    expect(content.url).not.toContain('media.test');
    expect(content.url.startsWith(`${h.minio.endpoint}/${h.minio.bucket}/`)).toBe(true);
    expect(content.mime_type).toBe('application/pdf');
    expect(content.file_name).toBe('treino.pdf');
    expect(requestsFor(name)).toHaveLength(1);
    expect(requestsFor(name)[0]?.method).toBe('GET');

    // The file is in the bucket, with the downloaded bytes.
    const stored = await fetch(content.url);
    expect(Buffer.from(await stored.arrayBuffer()).equals(PDF)).toBe(true);
    const media = await h.prisma.mediaObject.findMany({ where: { tenantId: f.tenant.id } });
    expect(media).toEqual([
      expect.objectContaining({
        direction: 'outbound',
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
      }),
    ]);
  });

  it('does not follow a redirect: the message fails and the provider gets nothing', async () => {
    const f = await fixture();
    const name = `${randomUUID()}.pdf`;
    files.next(respond(302, '', { location: 'http://api:3000/metrics' }));
    const response = await sendMedia(f, fileUrl(name));
    expect(response.statusCode).toBe(202);
    const row = await finalStatus(response.json().id as string);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBe('media_download_failed');
    expect(h.provider.sentTo(f.instance.providerName)).toHaveLength(0);
    expect(requestsFor(name)).toHaveLength(1);
  });

  it('fails at once for a 404 and for a file type that WhatsApp does not accept', async () => {
    const f = await fixture();
    const missing = `${randomUUID()}.pdf`;
    files.next(respond(404, 'not found'));
    const first = await sendMedia(f, fileUrl(missing));
    const notFound = await finalStatus(first.json().id as string);
    expect(notFound.failureReason).toBe('media_download_failed');
    expect(requestsFor(missing)).toHaveLength(1);

    const page = `${randomUUID()}.pdf`;
    files.next(respond(200, '<html></html>', { 'content-type': 'text/html' }));
    const second = await sendMedia(f, fileUrl(page));
    const html = await finalStatus(second.json().id as string);
    expect(html.failureReason).toBe('media_type_not_accepted');
    expect(h.provider.sentTo(f.instance.providerName)).toHaveLength(0);
  });

  it('retries a server error, then sends', async () => {
    const f = await fixture();
    const name = `${randomUUID()}.pdf`;
    files.next(
      respond(503, 'busy'),
      respond(200, PDF.toString('latin1'), { 'content-type': 'application/pdf' }),
    );
    const response = await sendMedia(f, fileUrl(name));
    const row = await finalStatus(response.json().id as string, 30_000);
    expect(row.status).toBe('sent');
    expect(requestsFor(name)).toHaveLength(2);
  });

  it('refuses at request time a URL that resolves to a forbidden address (422)', async () => {
    const f = await fixture();
    const response = await sendMedia(f, 'https://metadata.test/hetzner/v1/metadata');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MEDIA_URL_FORBIDDEN' });
    const unknown = await sendMedia(f, 'https://unknown.test/file.pdf');
    expect(unknown.statusCode).toBe(422);
    expect(await h.prisma.message.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });
});
