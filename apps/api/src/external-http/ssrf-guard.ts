import { lookup } from 'node:dns/promises';
import { ExternalHttpError } from '../ports/external-http.port';
import { forbiddenRangeOf, parseIp } from './address-policy';
import type { IpFamily } from './address-policy';

export interface ResolvedAddress {
  address: string;
  family: IpFamily;
}

/** Resolves a host name to all its addresses. Tests replace it (`DNS_RESOLVER`). */
export interface DnsResolver {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

/** The system resolver (`getaddrinfo`, the same answer as a normal connection). */
export const systemDnsResolver: DnsResolver = {
  async resolve(hostname) {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({
      address: answer.address,
      family: answer.family === 6 ? 6 : 4,
    }));
  },
};

export interface SsrfGuardOptions {
  /** HTTP (not HTTPS) URLs. Only outside production. */
  allowHttp: boolean;
  /** Private, loopback, and link-local addresses. Only outside production, for tests. */
  allowPrivate: boolean;
}

/** A URL that passed the checks, with the addresses that the connection must use. */
export interface CheckedTarget {
  url: URL;
  addresses: ResolvedAddress[];
}

/** Ranges that `allowPrivate` does not open. */
const ALWAYS_FORBIDDEN = new Set(['invalid', 'metadata', 'unspecified', 'multicast']);

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL', 'EAI_FAIL']);

function isDnsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && DNS_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? '');
}

/**
 * The SSRF guard of the client URLs (webhooks, the `external` condition, `call_webhook`).
 * `check(url)` validates the URL, resolves the host one time, and refuses the URL when one address is in a
 * forbidden range. The HTTP client then connects only to the checked addresses (no second lookup), so a
 * DNS answer that changes between the check and the connection (DNS rebinding) cannot reach a private
 * address.
 */
export class SsrfGuard {
  constructor(
    private readonly resolver: DnsResolver,
    private readonly options: SsrfGuardOptions,
  ) {}

  /** Throws `ExternalHttpError` (`forbidden_address` or `network`). */
  async check(rawUrl: string): Promise<CheckedTarget> {
    const url = this.parseUrl(rawUrl);
    const literal = parseIp(url.hostname);
    const addresses: ResolvedAddress[] = literal
      ? [{ address: url.hostname.replace(/^\[|\]$/g, ''), family: literal.family }]
      : await this.resolve(url.hostname);
    if (addresses.length === 0) {
      throw new ExternalHttpError('network', 'The host name has no address');
    }
    for (const { address } of addresses) {
      this.assertAddress(address);
    }
    return { url, addresses };
  }

  private parseUrl(rawUrl: string): URL {
    if (!URL.canParse(rawUrl)) {
      throw new ExternalHttpError('forbidden_address', 'The URL is not valid');
    }
    const url = new URL(rawUrl);
    const schemeAllowed =
      url.protocol === 'https:' || (url.protocol === 'http:' && this.options.allowHttp);
    if (!schemeAllowed) {
      throw new ExternalHttpError('forbidden_address', `The scheme ${url.protocol} is not allowed`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new ExternalHttpError('forbidden_address', 'The URL must not contain credentials');
    }
    return url;
  }

  private async resolve(hostname: string): Promise<ResolvedAddress[]> {
    try {
      return await this.resolver.resolve(hostname);
    } catch (error) {
      if (isDnsError(error)) {
        throw new ExternalHttpError('network', `DNS lookup failed (${error.code})`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private assertAddress(address: string): void {
    const label = forbiddenRangeOf(address);
    if (label === null || (this.options.allowPrivate && !ALWAYS_FORBIDDEN.has(label))) {
      return;
    }
    throw new ExternalHttpError(
      'forbidden_address',
      `The address is in a forbidden range (${label})`,
    );
  }
}
