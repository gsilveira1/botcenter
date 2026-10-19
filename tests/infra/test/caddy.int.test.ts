import { request } from 'node:https';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeImage, prodImage } from './helpers/images.js';
import { readRepoFile } from './helpers/repo.js';

const DOMAIN = 'botcenter.test';

/** The fake API: it reads the whole body and answers with the request data that Caddy forwarded. */
const UPSTREAM = `
const http = require('node:http');
http.createServer((req, res) => {
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-powered-by', 'fake');
    res.end(JSON.stringify({ url: req.url, size, xff: req.headers['x-forwarded-for'] ?? null,
      realIp: req.headers['x-real-ip'] ?? null, cf: req.headers['cf-connecting-ip'] ?? null }));
  });
}).listen(3000);
`;

let network: StartedNetwork;
let upstream: StartedTestContainer;
let caddy: StartedTestContainer;
let trustingCaddy: StartedTestContainer;

async function startCaddy(cloudflareSnippet: string): Promise<StartedTestContainer> {
  return new GenericContainer(prodImage('caddy'))
    .withNetwork(network)
    .withUser('1000:1000')
    .withAddedCapabilities('NET_BIND_SERVICE')
    .withEnvironment({ BOTCENTER_DOMAIN: DOMAIN, CADDY_TLS: 'internal' })
    .withCopyContentToContainer([
      { content: readRepoFile('infra/caddy/Caddyfile'), target: '/etc/caddy/Caddyfile' },
      { content: cloudflareSnippet, target: '/etc/caddy/cloudflare-ips.caddy' },
    ])
    .withExposedPorts(443, 8081)
    .withWaitStrategy(Wait.forHttp('/healthz', 8081))
    .start();
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  container: StartedTestContainer,
  path: string,
  options: { method?: string; body?: Buffer; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: container.getHost(),
        port: container.getMappedPort(443),
        servername: DOMAIN,
        path,
        method: options.method ?? 'GET',
        headers: { host: DOMAIN, ...options.headers },
        // `tls internal`: a certificate of the local CA of Caddy.
        rejectUnauthorized: false,
        // A new connection for each request: after a 413, the rest of a large body stays on the socket.
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', (error: NodeJS.ErrnoException) => {
      // Caddy can close the connection while the client still sends a body that is too large.
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
        resolve({ status: -1, headers: {}, body: error.code });
      } else {
        reject(error);
      }
    });
    req.end(options.body);
  });
}

beforeAll(async () => {
  network = await new Network().start();
  upstream = await new GenericContainer(nodeImage())
    .withNetwork(network)
    .withNetworkAliases('api', 'uptime-kuma')
    .withCommand(['node', '-e', UPSTREAM])
    .withWaitStrategy(Wait.forListeningPorts())
    .withExposedPorts(3000)
    .start();
  caddy = await startCaddy(readRepoFile('infra/caddy/cloudflare-ips.caddy'));
  // A second Caddy that trusts the private ranges, as it trusts Cloudflare in production.
  trustingCaddy = await startCaddy('trusted_proxies static private_ranges');
});

afterAll(async () => {
  await trustingCaddy?.stop();
  await caddy?.stop();
  await upstream?.stop();
  await network?.stop();
});

describe('infra/caddy/Caddyfile', () => {
  it('forwards /v1/* and /health/* to the API', async () => {
    const v1 = await call(caddy, '/v1/messages/abc');
    expect(v1.status).toBe(200);
    expect(JSON.parse(v1.body).url).toBe('/v1/messages/abc');
    expect((await call(caddy, '/health/ready')).status).toBe(200);
  });

  it('answers 404 for /internal/*, /metrics, and every other path', async () => {
    for (const path of ['/internal/evolution/webhook', '/metrics', '/', '/v2/x', '/healthz']) {
      const answer = await call(caddy, path, { method: 'POST', body: Buffer.from('{}') });
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toContain('"status":404');
    }
  });

  it('never forwards a path traversal or an encoded separator', async () => {
    // Caddy cleans the path before the matchers. The `@suspicious` matcher is a second layer.
    for (const path of [
      '/v1/..%2finternal/evolution/webhook',
      '/v1/../metrics',
      '/health/..%2F..%2Finternal/x',
    ]) {
      const answer = await call(caddy, path);
      expect([400, 404], path).toContain(answer.status);
      expect(answer.body, path).not.toContain('"url"');
    }
  });

  it('refuses a body above 2 MiB and accepts one below', async () => {
    const small = await call(caddy, '/v1/messages', {
      method: 'POST',
      body: Buffer.alloc(1024 * 1024),
    });
    expect(small.status).toBe(200);
    const large = await call(caddy, '/v1/messages', {
      method: 'POST',
      body: Buffer.alloc(3 * 1024 * 1024),
    });
    expect([413, -1]).toContain(large.status);
  });

  it('sets the security headers and removes the Server and X-Powered-By headers', async () => {
    const answer = await call(caddy, '/v1/messages/abc');
    expect(answer.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['content-security-policy']).toContain("default-src 'none'");
    expect(answer.headers.server).toBeUndefined();
    expect(answer.headers['x-powered-by']).toBeUndefined();
  });

  it('ignores CF-Connecting-IP from a peer that is not Cloudflare', async () => {
    const answer = await call(caddy, '/v1/ip', {
      headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' },
    });
    const seen = JSON.parse(answer.body) as { xff: string; realIp: string; cf: string | null };
    expect(seen.xff).not.toContain('203.0.113.7');
    expect(seen.xff).not.toContain('198.51.100.1');
    expect(seen.realIp).toBe(seen.xff);
    expect(seen.cf).toBeNull();
  });

  it('uses CF-Connecting-IP from a trusted proxy as the one client IP', async () => {
    const answer = await call(trustingCaddy, '/v1/ip', {
      headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' },
    });
    const seen = JSON.parse(answer.body) as { xff: string; realIp: string };
    expect(seen.xff).toBe('203.0.113.7');
    expect(seen.realIp).toBe('203.0.113.7');
  });

  it('writes no query string and no connect token to the access log', async () => {
    await call(caddy, '/v1/connect/secret-token-123/events?x=1');
    await call(caddy, '/v1/messages?api_key=leak');
    // The log writer is asynchronous.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const logs = await caddy.logs();
    const text = await new Promise<string>((resolve) => {
      let all = '';
      logs.on('data', (line: Buffer | string) => (all += line.toString()));
      setTimeout(() => {
        logs.destroy();
        resolve(all);
      }, 500);
    });
    expect(text).toContain('/v1/connect/REDACTED/events?REDACTED');
    expect(text).toContain('/v1/messages?REDACTED');
    expect(text).not.toContain('secret-token-123');
    expect(text).not.toContain('leak');
  });
});
