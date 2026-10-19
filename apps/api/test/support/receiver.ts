import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** What the receiver does with one request. The default answers 204. */
export type ReceiverBehavior = (request: ReceivedRequest, response: ServerResponse) => void;

export interface TlsMaterial {
  cert: string;
  key: string;
}

/**
 * Makes a self-signed certificate for the given DNS names and `127.0.0.1` with the `openssl` CLI.
 * Tests pass `cert` as the trusted CA of the client (`ExternalHttpClientOptions.ca`).
 */
export async function selfSignedCertificate(dnsNames: string[]): Promise<TlsMaterial> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcenter-tls-'));
  try {
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    const altNames = [...dnsNames.map((name) => `DNS:${name}`), 'IP:127.0.0.1'].join(',');
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${dnsNames[0] ?? 'localhost'}`,
      '-addext',
      `subjectAltName=${altNames}`,
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ]);
    return { cert: await readFile(certFile, 'utf8'), key: await readFile(keyFile, 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A local webhook receiver on `127.0.0.1` (random port). It records each request and answers with the
 * next queued behavior, or with the default behavior (204).
 */
export class TestReceiver {
  readonly requests: ReceivedRequest[] = [];
  private readonly queue: ReceiverBehavior[] = [];

  private constructor(
    private readonly server: http.Server | https.Server,
    readonly url: string,
  ) {}

  static async start(tls?: TlsMaterial): Promise<TestReceiver> {
    const ref: { current?: TestReceiver } = {};
    const handler = (incoming: IncomingMessage, response: ServerResponse) => {
      void ref.current?.handle(incoming, response);
    };
    const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    ref.current = new TestReceiver(server, `${tls ? 'https' : 'http'}://127.0.0.1:${port}`);
    return ref.current;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Queues the behavior of the next requests, in order. */
  next(...behaviors: ReceiverBehavior[]): void {
    this.queue.push(...behaviors);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(chunk as Buffer);
    }
    const request: ReceivedRequest = {
      method: incoming.method ?? '',
      url: incoming.url ?? '',
      headers: incoming.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    this.requests.push(request);
    const behavior = this.queue.shift() ?? respond(204);
    behavior(request, response);
  }
}

/** Answers with the status and an optional body. */
export function respond(status: number, body = '', headers: Record<string, string> = {}) {
  return (_request: ReceivedRequest, response: ServerResponse) => {
    response.writeHead(status, headers).end(body);
  };
}

/** Never answers (the client must stop at its time limit). */
export function hang(): ReceiverBehavior {
  return () => undefined;
}
