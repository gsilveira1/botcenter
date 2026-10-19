export type ExternalCallErrorKind =
  /** The service did not answer in `timeoutMs`. */
  | 'timeout'
  /** DNS, TCP, or TLS error. */
  | 'network'
  /** The service answered with a status that is not 2xx. */
  | 'http_status'
  /** The body is not JSON. */
  | 'invalid_json'
  /** The SSRF guard refused the URL. */
  | 'blocked';

/** The error that an `ExternalCaller` throws. The engine changes it into a false condition. */
export class ExternalCallError extends Error {
  constructor(
    readonly kind: ExternalCallErrorKind,
    message: string,
    readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ExternalCallError';
  }
}

/**
 * The snapshot or the definition does not agree with the engine rules (for example, a state that
 * the definition does not have). This is a data error: the API logs it and sends an alert.
 */
export class EngineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineStateError';
  }
}
