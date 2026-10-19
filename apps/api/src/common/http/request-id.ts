import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Fastify `genReqId`: the `X-Request-Id` of the caller when it is a safe token (Caddy or a client
 * can send one), otherwise a new UUID. A value with other characters is not copied into the logs.
 */
export function generateRequestId(request: IncomingMessage): string {
  const header = request.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value && VALID_REQUEST_ID.test(value) ? value : randomUUID();
}
