// HTTPS client of the smoke test. It connects to Caddy on 127.0.0.1 with the public host name in SNI
// and in `Host`, and it trusts only the local CA of Caddy (`tls internal`).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createSseParser } from './sse.mjs';

/**
 * @typedef {{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string, json: any }} HttpAnswer
 * @typedef {{ host: string, port: number, domain: string, ca?: Buffer, tls: boolean }} Target
 */

/**
 * @param {{ httpsPort: number, httpPort: number, domain: string, caFile: string }} options
 */
export function createClient({ httpsPort, httpPort, domain, caFile }) {
  const ca = readFileSync(caFile);
  /** @type {Target} */
  const secure = { host: '127.0.0.1', port: httpsPort, domain, ca, tls: true };
  /** @type {Target} */
  const plain = { host: '127.0.0.1', port: httpPort, domain, tls: false };
  return {
    /**
     * @param {string} method
     * @param {string} path
     * @param {{ headers?: Record<string, string>, body?: unknown, plain?: boolean }} [options]
     * @returns {Promise<HttpAnswer>}
     */
    request: (method, path, options = {}) =>
      send(options.plain ? plain : secure, method, path, options),
    /**
     * Opens an SSE stream and collects the events until `until(events)` is true or the time ends.
     * @param {string} path
     * @param {{ timeoutMs: number, until: (events: Array<{ event: string, data: any }>) => boolean }} options
     */
    events: (path, options) => openEvents(secure, path, options),
  };
}

/**
 * @param {Target} target
 * @param {string} path
 * @param {string} method
 * @param {Record<string, string>} headers
 */
function requestOptions(target, method, path, headers) {
  return {
    host: target.host,
    port: target.port,
    method,
    path,
    servername: target.domain,
    ca: target.ca,
    headers: { host: `${target.domain}:${target.port}`, ...headers },
    timeout: 30_000,
  };
}

/**
 * @param {Target} target
 * @param {string} method
 * @param {string} path
 * @param {{ headers?: Record<string, string>, body?: unknown }} options
 * @returns {Promise<HttpAnswer>}
 */
function send(target, method, path, { headers = {}, body }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const allHeaders = payload
    ? {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        ...headers,
      }
    : headers;
  const transport = target.tls ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(requestOptions(target, method, path, allHeaders), (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: parseJson(text) });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: no answer after 30 s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {Target} target
 * @param {string} path
 * @param {{ timeoutMs: number, until: (events: Array<{ event: string, data: any }>) => boolean }} options
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, events: Array<{ event: string, data: any }>, text: string, endedBy: string }>}
 */
function openEvents(target, path, { timeoutMs, until }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const parse = createSseParser();
    let settled = false;
    const req = https.request(
      requestOptions(target, 'GET', path, { accept: 'text/event-stream' }),
      (res) => {
        const finish = (endedBy, text = '') => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, events, text, endedBy });
        };
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => finish('status', Buffer.concat(chunks).toString('utf8')));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          for (const message of parse(chunk)) {
            events.push({ event: message.event, data: parseJson(message.data) ?? message.data });
          }
          if (until(events)) finish('condition');
        });
        res.on('end', () => finish('server_end'));
        res.on('error', (error) => finish(`error: ${error.message}`));
      },
    );
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    req.end();
  });
}
