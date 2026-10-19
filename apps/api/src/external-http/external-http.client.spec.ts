import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hang, respond, selfSignedCertificate, TestReceiver } from '../../test/support/receiver';
import type { TlsMaterial } from '../../test/support/receiver';
import { ExternalHttpError } from '../ports/external-http.port';
import { EXTERNAL_HTTP_USER_AGENT, ExternalHttpClient } from './external-http.client';
import { SsrfGuard } from './ssrf-guard';
import type { DnsResolver, ResolvedAddress, SsrfGuardOptions } from './ssrf-guard';

const LOCAL: SsrfGuardOptions = { allowHttp: true, allowPrivate: true };
const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };

function clientWith(
  options: SsrfGuardOptions = LOCAL,
  resolver: DnsResolver = { resolve: async () => [LOOPBACK] },
  extra: { ca?: string; maxResponseBytes?: number } = {},
): ExternalHttpClient {
  const client = new ExternalHttpClient(new SsrfGuard(resolver, options), {
    maxResponseBytes: extra.maxResponseBytes ?? 1024,
    ...(extra.ca ? { ca: extra.ca } : {}),
  });
  clients.push(client);
  return client;
}

async function failure(promise: Promise<unknown>): Promise<ExternalHttpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ExternalHttpError);
  return error as ExternalHttpError;
}

const clients: ExternalHttpClient[] = [];
let receiver: TestReceiver;

beforeAll(async () => {
  receiver = await TestReceiver.start();
});

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

afterAll(async () => {
  await receiver.close();
});

describe('ExternalHttpClient.postJson', () => {
  it('posts JSON with the fixed User-Agent and parses the JSON answer', async () => {
    receiver.next(respond(200, '{"ok":true,"score":7}', { 'content-type': 'application/json' }));
    const response = await clientWith().postJson({
      url: `${receiver.url}/check?x=1`,
      body: { phone: 'masked' },
      timeoutMs: 2_000,
      headers: { 'x-extra': 'yes', 'user-agent': 'spoofed', host: 'evil.example' },
    });
    expect(response).toEqual({ status: 200, json: { ok: true, score: 7 } });
    const request = receiver.requests.at(-1);
    expect(request).toMatchObject({
      method: 'POST',
      url: '/check?x=1',
      body: '{"phone":"masked"}',
    });
    expect(request?.headers['user-agent']).toBe(EXTERNAL_HTTP_USER_AGENT);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['x-extra']).toBe('yes');
    expect(request?.headers['host']).toBe(`127.0.0.1:${receiver.port}`);
  });

  it('returns an HTTP error status as a normal response and null for a body that is not JSON', async () => {
    receiver.next(respond(503, 'busy'));
    await expect(
      clientWith().postJson({ url: receiver.url, body: {}, timeoutMs: 2_000 }),
    ).resolves.toEqual({ status: 503, json: null });
  });

  it('never follows a redirect', async () => {
    receiver.next(respond(302, '', { location: 'http://169.254.169.254/latest/meta-data' }));
    const before = receiver.requests.length;
    const response = await clientWith().postJson({ url: receiver.url, body: {}, timeoutMs: 2_000 });
    expect(response.status).toBe(302);
    expect(receiver.requests.length).toBe(before + 1);
  });

  it('refuses a response above the size limit', async () => {
    receiver.next(respond(200, 'x'.repeat(5_000)));
    const error = await failure(
      clientWith().postJson({ url: receiver.url, body: {}, timeoutMs: 2_000 }),
    );
    expect(error.code).toBe('response_too_large');
  });

  it('keeps the status of a large response when the caller discards the large body', async () => {
    receiver.next(respond(202, 'x'.repeat(5_000)));
    await expect(
      clientWith().postJson({
        url: receiver.url,
        body: {},
        timeoutMs: 2_000,
        discardLargeBody: true,
        maxResponseBytes: 100,
      }),
    ).resolves.toEqual({ status: 202, json: null });
  });

  it('stops at the time limit', async () => {
    receiver.next(hang());
    const started = Date.now();
    const error = await failure(
      clientWith().postJson({ url: receiver.url, body: {}, timeoutMs: 200 }),
    );
    expect(error.code).toBe('timeout');
    // A wide bound: the gate runs many test processes at once on one machine.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('stops at the time limit also when the DNS lookup hangs', async () => {
    const resolver: DnsResolver = { resolve: () => new Promise(() => undefined) };
    const error = await failure(
      clientWith(LOCAL, resolver).postJson({
        url: 'http://slow-dns.test/',
        body: {},
        timeoutMs: 100,
      }),
    );
    expect(error.code).toBe('timeout');
  });

  it('gives a network error when the connection fails', async () => {
    const closed = await TestReceiver.start();
    const url = closed.url;
    await closed.close();
    const error = await failure(clientWith().postJson({ url, body: {}, timeoutMs: 2_000 }));
    expect(error.code).toBe('network');
  });

  it('refuses a private address in strict mode before any connection', async () => {
    const before = receiver.requests.length;
    const strict = { allowHttp: true, allowPrivate: false };
    const error = await failure(
      clientWith(strict).postJson({ url: receiver.url, body: {}, timeoutMs: 2_000 }),
    );
    expect(error.code).toBe('forbidden_address');
    expect(receiver.requests.length).toBe(before);
  });
});

describe('ExternalHttpClient.send', () => {
  it('sends the exact body and keeps the status of a large body when discardLargeBody is set', async () => {
    receiver.next(respond(200, 'y'.repeat(10_000)));
    const response = await clientWith().send({
      url: receiver.url,
      body: '{"b":1, "a":2}',
      timeoutMs: 2_000,
      discardLargeBody: true,
      maxResponseBytes: 100,
    });
    expect(response.status).toBe(200);
    expect(receiver.requests.at(-1)?.body).toBe('{"b":1, "a":2}');
  });

  it('connects to the checked address only: a second DNS answer is never used (rebinding)', async () => {
    const answers = [[LOOPBACK], [{ address: '10.255.255.1', family: 4 as const }]];
    const resolver: DnsResolver = { resolve: vi.fn(async () => answers.shift() ?? []) };
    const client = clientWith(LOCAL, resolver);
    const response = await client.send({
      url: `http://rebind.test:${receiver.port}/`,
      body: '{}',
      timeoutMs: 2_000,
    });
    expect(response.status).toBe(204);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(receiver.requests.at(-1)?.headers['host']).toBe(`rebind.test:${receiver.port}`);
  });
});

describe('ExternalHttpClient.getBinary (SEC-01)', () => {
  it('downloads the bytes with a GET, the fixed User-Agent, and the media type of the answer', async () => {
    receiver.next(respond(200, 'PDF bytes', { 'content-type': 'Application/PDF; charset=binary' }));
    const response = await clientWith().getBinary({
      url: `${receiver.url}/file.pdf`,
      timeoutMs: 2_000,
      maxBytes: 100,
    });
    expect(response).toEqual({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('PDF bytes'),
    });
    const request = receiver.requests.at(-1);
    expect(request).toMatchObject({ method: 'GET', url: '/file.pdf', body: '' });
    expect(request?.headers['user-agent']).toBe(EXTERNAL_HTTP_USER_AGENT);
    expect(request?.headers['content-length']).toBeUndefined();
  });

  it('refuses a body above the limit, does not follow a redirect, and applies the SSRF guard', async () => {
    receiver.next(respond(200, 'z'.repeat(5_000)));
    const large = await failure(
      clientWith().getBinary({ url: receiver.url, timeoutMs: 2_000, maxBytes: 1_000 }),
    );
    expect(large.code).toBe('response_too_large');

    receiver.next(respond(302, '', { location: 'http://169.254.169.254/' }));
    const redirect = await clientWith().getBinary({
      url: receiver.url,
      timeoutMs: 2_000,
      maxBytes: 1_000,
    });
    expect(redirect.status).toBe(302);

    const strict = clientWith({ allowHttp: true, allowPrivate: false });
    const forbidden = await failure(
      strict.getBinary({ url: receiver.url, timeoutMs: 2_000, maxBytes: 1_000 }),
    );
    expect(forbidden.code).toBe('forbidden_address');
  });
});

describe('ExternalHttpClient over HTTPS', () => {
  let tls: TlsMaterial;
  let secure: TestReceiver;

  beforeAll(async () => {
    tls = await selfSignedCertificate(['hooks.test']);
    secure = await TestReceiver.start(tls);
  });

  afterAll(async () => {
    await secure.close();
  });

  it('verifies the certificate against the host name while it connects to the checked address', async () => {
    const client = clientWith({ allowHttp: false, allowPrivate: true }, undefined, {
      ca: tls.cert,
    });
    const response = await client.send({
      url: `https://hooks.test:${secure.port}/hook`,
      body: '{}',
      timeoutMs: 2_000,
    });
    expect(response.status).toBe(204);
  });

  it('refuses a certificate that does not match the host name', async () => {
    const client = clientWith({ allowHttp: false, allowPrivate: true }, undefined, {
      ca: tls.cert,
    });
    const error = await failure(
      client.send({ url: `https://other.test:${secure.port}/`, body: '{}', timeoutMs: 2_000 }),
    );
    expect(error.code).toBe('network');
  });

  it('refuses an untrusted certificate', async () => {
    const client = clientWith({ allowHttp: false, allowPrivate: true });
    const error = await failure(
      client.send({ url: `https://hooks.test:${secure.port}/`, body: '{}', timeoutMs: 2_000 }),
    );
    expect(error.code).toBe('network');
  });
});
