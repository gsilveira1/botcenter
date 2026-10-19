import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';
import { maskDigits, type ProviderLogger } from '../logger.js';
import { ProviderError, type ProviderErrorCode } from '../types.js';

/** The part of a fetch `Response` that the adapter uses. */
export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/** A fetch function. The default is the `fetch` of `undici` with a keep-alive `Agent`. */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export interface EvolutionResponse {
  status: number;
  body: unknown;
}

export interface EvolutionCall {
  /** A name for logs and errors, for example `sendMessage`. */
  operation: string;
  method: 'GET' | 'POST' | 'DELETE';
  /** The path with the query string, for example `/instance/connect/inst_1?number=5511999990000`. */
  path: string;
  /** The route without the instance name and the query, for logs and errors. */
  route: string;
  instanceName?: string;
  body?: unknown;
  timeoutMs: number;
  /** Message content of the request. The log replaces each value with `[content]` in an Evolution error. */
  redact?: string[];
}

export interface EvolutionHttpOptions {
  baseUrl: string;
  apiKey: string;
  logger: ProviderLogger;
  fetch?: FetchLike;
  dispatcher?: Dispatcher;
}

/** Creates the default keep-alive agent: the Evolution API is on the same private network. */
export function createKeepAliveAgent(): Agent {
  return new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 120_000, connections: 64 });
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * The HTTP client of the Evolution API. It sends the global API key in the `apikey` header.
 * It returns every HTTP status to the caller and throws `ProviderError` (`unavailable`) only for
 * network errors and timeouts.
 */
export class EvolutionHttp {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly ownedAgent: Agent | undefined;

  constructor(private readonly options: EvolutionHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (options.fetch) {
      this.fetchFn = options.fetch;
      this.ownedAgent = undefined;
    } else {
      const dispatcher = options.dispatcher ?? createKeepAliveAgent();
      this.ownedAgent = options.dispatcher ? undefined : (dispatcher as Agent);
      this.fetchFn = (url, init) => undiciFetch(url, { ...init, dispatcher });
    }
  }

  /** Closes the keep-alive agent that this client created. */
  async close(): Promise<void> {
    await this.ownedAgent?.close();
  }

  async call(call: EvolutionCall): Promise<EvolutionResponse> {
    const headers: Record<string, string> = {
      apikey: this.options.apiKey,
      accept: 'application/json',
    };
    const init: HttpRequestInit = {
      method: call.method,
      headers,
      signal: AbortSignal.timeout(call.timeoutMs),
    };
    if (call.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(call.body);
    }

    const started = Date.now();
    let response: HttpResponseLike;
    let text: string;
    try {
      response = await this.fetchFn(`${this.baseUrl}${call.path}`, init);
      text = await response.text();
    } catch (error) {
      const timeout = isTimeout(error);
      this.options.logger.warn(
        {
          operation: call.operation,
          route: call.route,
          instance_name: call.instanceName,
          duration_ms: Date.now() - started,
          timeout,
          error_name: error instanceof Error ? error.name : typeof error,
          error_code: (error as { cause?: { code?: string } } | undefined)?.cause?.code,
        },
        'Evolution request failed before a response',
      );
      throw new ProviderError(
        'unavailable',
        timeout
          ? `Evolution ${call.operation} timed out after ${call.timeoutMs} ms`
          : `Evolution ${call.operation} failed: network error`,
        undefined,
        { cause: error },
      );
    }

    return { status: response.status, body: parseBody(text) };
  }

  /** Builds a `ProviderError` and writes the technical details (masked) to the log. */
  fail(
    call: EvolutionCall,
    response: EvolutionResponse,
    code: ProviderErrorCode = defaultCode(response),
  ): ProviderError {
    const detail = redact(firstMessage(response.body), call.redact);
    this.options.logger.warn(
      {
        operation: call.operation,
        route: call.route,
        instance_name: call.instanceName,
        http_status: response.status,
        provider_error_code: code,
        evolution_error: detail === undefined ? undefined : maskDigits(detail).slice(0, 200),
      },
      'Evolution request failed',
    );
    return new ProviderError(
      code,
      `Evolution ${call.operation} failed with HTTP ${response.status} (${code})`,
      response.status,
    );
  }
}

function redact(text: string | undefined, values: string[] | undefined): string | undefined {
  if (text === undefined || !values) return text;
  return values
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((result, value) => result.split(value).join('[content]'), text);
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}

/**
 * The messages of an Evolution error body: `{ status, error, response: { message: [...] | string } }`.
 * Each item is a string or an object (for example `{ jid, exists: false, number }`).
 */
export function errorMessages(body: unknown): unknown[] {
  if (typeof body !== 'object' || body === null) return typeof body === 'string' ? [body] : [];
  const response = (body as { response?: { message?: unknown } }).response;
  const message = response?.message ?? (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.flat();
  return message === undefined ? [] : [message];
}

export function firstMessage(body: unknown): string | undefined {
  const first = errorMessages(body)[0];
  if (first === undefined) return undefined;
  return typeof first === 'string' ? first : JSON.stringify(first);
}

export function hasMessage(body: unknown, pattern: RegExp): boolean {
  return errorMessages(body).some((item) => typeof item === 'string' && pattern.test(item));
}

/** HTTP status to error code: 5xx, 408, and 429 are `unavailable`; 404 of an instance is `not_found`. */
export function defaultCode(response: EvolutionResponse): ProviderErrorCode {
  const { status } = response;
  if (status >= 500 || status === 408 || status === 429) return 'unavailable';
  if (status === 404 && hasMessage(response.body, /instance does not exist|not found/i)) {
    return 'not_found';
  }
  return 'rejected';
}
