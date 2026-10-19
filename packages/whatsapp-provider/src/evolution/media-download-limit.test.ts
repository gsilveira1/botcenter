import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderLogger } from '../logger.js';
import { MediaTooLargeError, ProviderError } from '../types.js';
import { EvolutionProvider, mediaResponseLimit } from './evolution-provider.js';

/**
 * Regression tests for ARCH-03 and SEC-02: one large inbound media file must not fill the memory of the
 * worker. A local HTTP server sends a huge `getBase64FromMediaMessage` answer in small chunks, and only
 * when the client reads them. The adapter must stop the read at the limit and abort the request.
 */

const MIB = 1024 * 1024;
const NAME = 'inst_0192f1a4-7c2e-7b51-9a0e-3f5d2c8b6e41';
const HUGE_BYTES = 200 * MIB;
const CHUNK = Buffer.alloc(64 * 1024, 'A');

const silent: ProviderLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface HugeServer {
  server: Server;
  url: string;
  /** The bytes of the body that the server wrote before the client closed the connection. */
  written: () => number;
  closed: () => Promise<void>;
}

/** Writes `{"base64":"AAAA...` up to `totalBytes`, one chunk each time the socket can take more data. */
function startHugeServer(totalBytes: number, contentLength: boolean): Promise<HugeServer> {
  let written = 0;
  let onClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(201, {
      'content-type': 'application/json',
      ...(contentLength ? { 'content-length': String(totalBytes + 64) } : {}),
    });
    response.write('{"mimetype":"video/mp4","base64":"');
    const pump = (): void => {
      while (written < totalBytes) {
        written += CHUNK.length;
        if (!response.write(CHUNK)) {
          response.once('drain', pump);
          return;
        }
      }
      response.end('"}');
    };
    response.on('close', onClose);
    pump();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        written: () => written,
        closed: () => closed,
      });
    });
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('The promise did not reject');
}

describe('EvolutionProvider.downloadMedia: size limit (ARCH-03, SEC-02)', () => {
  let streamed: HugeServer;
  let declared: HugeServer;

  beforeAll(async () => {
    streamed = await startHugeServer(HUGE_BYTES, false);
    declared = await startHugeServer(HUGE_BYTES, true);
  });

  afterAll(async () => {
    streamed.server.closeAllConnections();
    declared.server.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => streamed.server.close(resolve)),
      new Promise((resolve) => declared.server.close(resolve)),
    ]);
  });

  it('aborts the download at the limit and keeps the memory bounded', async () => {
    const provider = new EvolutionProvider({ baseUrl: streamed.url, apiKey: 'k', logger: silent });
    const maxBytes = 16 * MIB;
    global.gc?.();
    const before = process.memoryUsage();

    const error = await rejection(provider.downloadMedia(NAME, 'BIG', { maxBytes }));

    const after = process.memoryUsage();
    expect(error).toBeInstanceOf(MediaTooLargeError);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('rejected');
    expect((error as MediaTooLargeError).maxBytes).toBe(maxBytes);
    await streamed.closed();
    // The server stops when the client closes the connection: it wrote the limit plus the socket buffers.
    expect(streamed.written()).toBeLessThan(mediaResponseLimit(maxBytes) + 8 * MIB);
    expect(streamed.written()).toBeLessThan(HUGE_BYTES / 4);
    // The read keeps at most the limit (about 21 MiB of base64) in memory, not the 200 MiB body.
    const growth = after.heapUsed + after.arrayBuffers - (before.heapUsed + before.arrayBuffers);
    expect(growth).toBeLessThan(64 * MIB);
    await provider.close();
  });

  it('refuses a declared Content-Length above the limit before it reads the body', async () => {
    const provider = new EvolutionProvider({ baseUrl: declared.url, apiKey: 'k', logger: silent });
    const error = await rejection(provider.downloadMedia(NAME, 'BIG', { maxBytes: MIB }));
    expect(error).toBeInstanceOf(MediaTooLargeError);
    await declared.closed();
    expect(declared.written()).toBeLessThan(16 * MIB);
    await provider.close();
  });

  it('uses the 16 MiB limit of the contracts when the caller gives no limit', () => {
    expect(mediaResponseLimit(16 * MIB)).toBeGreaterThan((16 * MIB * 4) / 3);
    expect(mediaResponseLimit(16 * MIB)).toBeLessThan(23 * MIB);
  });

  it('refuses a decoded file above the limit when the body fits in the envelope slack', async () => {
    const data = Buffer.alloc(1024 + 3, 1);
    const provider = new EvolutionProvider({
      baseUrl: 'http://evolution:8080',
      apiKey: 'k',
      logger: silent,
      fetch: async () => ({
        status: 201,
        text: async () =>
          JSON.stringify({ mimetype: 'image/png', base64: data.toString('base64') }),
      }),
    });
    const error = await rejection(provider.downloadMedia(NAME, 'X', { maxBytes: 1024 }));
    expect(error).toBeInstanceOf(MediaTooLargeError);
    const ok = await provider.downloadMedia(NAME, 'X', { maxBytes: 2048 });
    expect(ok.data).toEqual(data);
  });
});
