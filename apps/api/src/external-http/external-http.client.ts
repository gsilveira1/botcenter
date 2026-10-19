import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { ExternalHttpError } from '../ports/external-http.port';
import type {
  ExternalHttpBinaryPort,
  ExternalHttpBinaryResponse,
  ExternalHttpGetRequest,
  ExternalHttpPort,
  ExternalHttpRequest,
  ExternalHttpResponse,
} from '../ports/external-http.port';
import type { CheckedTarget, ResolvedAddress, SsrfGuard } from './ssrf-guard';

/** The fixed `User-Agent` of every call to a client URL. */
export const EXTERNAL_HTTP_USER_AGENT = 'BotCenter/1.0 (+outgoing webhooks)';

/** Maximum time of one call. A caller that asks for more gets this value. */
export const EXTERNAL_HTTP_MAX_TIMEOUT_MS = 30_000;

/** Headers that only the client sets. A caller value for one of them is dropped. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'user-agent',
]);

export interface ExternalHttpSendRequest {
  url: string;
  /** Default `POST`. A `GET` sends no body (`body` must be empty). */
  method?: 'GET' | 'POST';
  /** The exact bytes to send (a webhook signature covers them). */
  body: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  /**
   * `true`: read at most the response limit and keep the status when the body is larger (webhook
   * deliveries need only the status). `false`: a larger body is `response_too_large`.
   */
  discardLargeBody?: boolean;
  maxResponseBytes?: number;
}

export interface ExternalHttpRawResponse {
  status: number;
  body: Buffer;
  /** The `Content-Type` header without parameters, in lower case, or `null`. */
  contentType?: string | null;
}

export interface ExternalHttpClientOptions {
  maxResponseBytes: number;
  /** Extra trusted CA certificates. Tests only (a local HTTPS receiver with a self-signed certificate). */
  ca?: string;
}

function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const [first] = addresses;
    if (!first) {
      callback(new ExternalHttpError('network', 'No checked address'), '', 4);
      return;
    }
    if (options.all) {
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

function toExternalError(error: unknown, signal: AbortSignal): ExternalHttpError {
  if (error instanceof ExternalHttpError) {
    return error;
  }
  if (signal.aborted) {
    return new ExternalHttpError('timeout', 'The call took more than its time limit', {
      cause: error,
    });
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
  return new ExternalHttpError('network', `The call failed (${code})`, { cause: error });
}

/** Rejects with `timeout` when the signal aborts before the promise settles. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toExternalError(signal.reason, signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** `text/HTML; charset=utf-8` gives `text/html`. */
function mediaTypeOf(header: string | undefined): string | null {
  const value = header?.split(';')[0]?.trim().toLowerCase();
  return value ? value : null;
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) {
    return null;
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/**
 * The HTTP client for client URLs (the frozen port `EXTERNAL_HTTP`). Every call goes through the SSRF
 * guard, connects only to the checked addresses, never follows a redirect (a 3xx is a normal response),
 * stops at the time limit, limits the response size, and sends a fixed `User-Agent`. No proxy variable
 * of the environment applies (`node:http` ignores them).
 */
export class ExternalHttpClient implements ExternalHttpPort, ExternalHttpBinaryPort {
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  constructor(
    private readonly guard: SsrfGuard,
    private readonly options: ExternalHttpClientOptions,
  ) {}

  async postJson(request: ExternalHttpRequest): Promise<ExternalHttpResponse> {
    const response = await this.send({
      url: request.url,
      body: JSON.stringify(request.body ?? null),
      timeoutMs: request.timeoutMs,
      ...(request.headers ? { headers: request.headers } : {}),
    });
    return { status: response.status, json: parseJson(response.body) };
  }

  /** Downloads a file with a `GET` (port `EXTERNAL_HTTP_BINARY`). Throws `ExternalHttpError` only. */
  async getBinary(request: ExternalHttpGetRequest): Promise<ExternalHttpBinaryResponse> {
    const response = await this.send({
      url: request.url,
      method: 'GET',
      body: '',
      timeoutMs: request.timeoutMs,
      maxResponseBytes: request.maxBytes,
    });
    return {
      status: response.status,
      contentType: response.contentType ?? null,
      body: response.body,
    };
  }

  /** Sends a JSON `POST` (or a `GET`) with the exact body. Throws `ExternalHttpError` only. */
  async send(request: ExternalHttpSendRequest): Promise<ExternalHttpRawResponse> {
    const timeoutMs = Math.min(Math.max(request.timeoutMs, 1), EXTERNAL_HTTP_MAX_TIMEOUT_MS);
    const signal = AbortSignal.timeout(timeoutMs);
    const target = await raceAbort(this.guard.check(request.url), signal);
    return raceAbort(this.request(target, request, signal), signal);
  }

  close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private request(
    target: CheckedTarget,
    request: ExternalHttpSendRequest,
    signal: AbortSignal,
  ): Promise<ExternalHttpRawResponse> {
    const isHttps = target.url.protocol === 'https:';
    const transport = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const outgoing = transport.request(
        target.url,
        {
          method: request.method ?? 'POST',
          agent: isHttps ? this.httpsAgent : this.httpAgent,
          lookup: pinnedLookup(target.addresses),
          signal,
          headers: this.headers(request),
          ...(isHttps && this.options.ca ? { ca: this.options.ca } : {}),
        },
        (response) => {
          this.readBody(response, request).then(resolve, (error: unknown) =>
            reject(toExternalError(error, signal)),
          );
        },
      );
      outgoing.on('error', (error) => reject(toExternalError(error, signal)));
      outgoing.end(request.body);
    });
  }

  private headers(request: ExternalHttpSendRequest): Record<string, string> {
    const extra = Object.entries(request.headers ?? {}).filter(
      ([name]) => !RESERVED_HEADERS.has(name.toLowerCase()),
    );
    if (request.method === 'GET') {
      return { ...Object.fromEntries(extra), 'user-agent': EXTERNAL_HTTP_USER_AGENT };
    }
    return {
      ...Object.fromEntries(extra),
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(request.body)),
      'user-agent': EXTERNAL_HTTP_USER_AGENT,
    };
  }

  private readBody(
    response: IncomingMessage,
    request: ExternalHttpSendRequest,
  ): Promise<ExternalHttpRawResponse> {
    const limit = request.maxResponseBytes ?? this.options.maxResponseBytes;
    const status = response.statusCode ?? 0;
    const contentType = mediaTypeOf(response.headers['content-type']);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= limit) {
          chunks.push(chunk);
          return;
        }
        response.destroy();
        if (request.discardLargeBody) {
          resolve({ status, contentType, body: Buffer.concat(chunks) });
          return;
        }
        reject(new ExternalHttpError('response_too_large', `The response is above ${limit} bytes`));
      });
      response.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
  }
}
