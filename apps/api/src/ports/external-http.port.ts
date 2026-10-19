/**
 * Frozen port for HTTP calls to URLs that a client supplies (webhook deliveries, the `external` condition
 * and the `call_webhook` action of the bot engine). The webhooks slice implements it with the SSRF guard:
 * HTTPS only in production, no private, loopback, link-local, or metadata address after the DNS lookup,
 * no redirects, a response size limit, and a time limit.
 */
export const EXTERNAL_HTTP = Symbol('EXTERNAL_HTTP');

export interface ExternalHttpRequest {
  url: string;
  body: unknown;
  timeoutMs: number;
  /** Extra headers, for example the webhook signature headers. */
  headers?: Record<string, string>;
  /**
   * `true`: read at most the response limit and keep the status when the body is larger (a delivery needs
   * only the status). Default `false`: a larger body is `response_too_large`.
   */
  discardLargeBody?: boolean;
  /** The response limit of this call, in bytes. Default: the limit of the client. */
  maxResponseBytes?: number;
}

export interface ExternalHttpResponse {
  status: number;
  /** The parsed JSON body, or `null` when the body is empty or not JSON. */
  json: unknown;
}

export type ExternalHttpErrorCode =
  'forbidden_address' | 'timeout' | 'network' | 'response_too_large';

export class ExternalHttpError extends Error {
  constructor(
    readonly code: ExternalHttpErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ExternalHttpError';
  }
}

export interface ExternalHttpPort {
  /** Sends a JSON `POST`. Throws `ExternalHttpError` only; an HTTP error status is a normal response. */
  postJson(request: ExternalHttpRequest): Promise<ExternalHttpResponse>;
}

/**
 * Additive port (outbound slice, SEC-01): download a file from a URL that a client supplies, with the
 * same SSRF guard, no redirects, and a time limit. The outbound worker stores the file in the private
 * bucket, so the provider never gets a client URL.
 */
export const EXTERNAL_HTTP_BINARY = Symbol('EXTERNAL_HTTP_BINARY');

export interface ExternalHttpGetRequest {
  url: string;
  timeoutMs: number;
  /** A larger body is `response_too_large`. */
  maxBytes: number;
}

export interface ExternalHttpBinaryResponse {
  status: number;
  /** The `Content-Type` header without parameters, in lower case, or `null`. */
  contentType: string | null;
  body: Buffer;
}

export interface ExternalHttpBinaryPort {
  /** Sends a `GET`. Throws `ExternalHttpError` only; an HTTP error status (also a 3xx) is a normal response. */
  getBinary(request: ExternalHttpGetRequest): Promise<ExternalHttpBinaryResponse>;
}
