import { describe, expect, it, vi } from 'vitest';
import { ExternalHttpError } from '../ports/external-http.port';
import { SsrfGuard, systemDnsResolver } from './ssrf-guard';
import type { DnsResolver, ResolvedAddress, SsrfGuardOptions } from './ssrf-guard';

const PUBLIC: ResolvedAddress = { address: '93.184.215.14', family: 4 };
const STRICT: SsrfGuardOptions = { allowHttp: false, allowPrivate: false };

function resolverOf(map: Record<string, ResolvedAddress[]>): DnsResolver {
  return {
    resolve: vi.fn(async (hostname: string) => {
      const answer = map[hostname];
      if (!answer) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      }
      return answer;
    }),
  };
}

async function failure(promise: Promise<unknown>): Promise<ExternalHttpError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ExternalHttpError);
  return error as ExternalHttpError;
}

describe('SsrfGuard', () => {
  it('accepts an HTTPS URL whose host resolves to public addresses only', async () => {
    const guard = new SsrfGuard(resolverOf({ 'hooks.example.com': [PUBLIC] }), STRICT);
    const target = await guard.check('https://hooks.example.com/botcenter');
    expect(target.url.hostname).toBe('hooks.example.com');
    expect(target.addresses).toEqual([PUBLIC]);
  });

  it('refuses a host when one of its addresses is private (no partial use of the answer)', async () => {
    const guard = new SsrfGuard(
      resolverOf({ 'mixed.example.com': [PUBLIC, { address: '10.0.0.7', family: 4 }] }),
      STRICT,
    );
    const error = await failure(guard.check('https://mixed.example.com/'));
    expect(error.code).toBe('forbidden_address');
    expect(error.message).toContain('private');
  });

  it.each([
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://[::ffff:a9fe:a9fe]/latest/meta-data',
    'https://169.254.169.254/latest/meta-data',
    'https://2130706433/hook',
    'https://0x7f.1/hook',
    'https://0/hook',
    'https://[fd00:ec2::254]/',
  ])('refuses the address literal in %s without a DNS lookup', async (url) => {
    const resolver = resolverOf({});
    const error = await failure(new SsrfGuard(resolver, STRICT).check(url));
    expect(error.code).toBe('forbidden_address');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('refuses HTTP in production mode, credentials, and other schemes', async () => {
    const guard = new SsrfGuard(resolverOf({ 'hooks.example.com': [PUBLIC] }), STRICT);
    for (const url of [
      'http://hooks.example.com/',
      'https://user:pw@hooks.example.com/',
      'ftp://hooks.example.com/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect((await failure(guard.check(url))).code).toBe('forbidden_address');
    }
  });

  it('accepts HTTP and private addresses only when the options allow them (tests)', async () => {
    const guard = new SsrfGuard(resolverOf({}), { allowHttp: true, allowPrivate: true });
    await expect(guard.check('http://127.0.0.1:8080/hook')).resolves.toMatchObject({
      addresses: [{ address: '127.0.0.1', family: 4 }],
    });
    // The metadata service stays closed, also in tests.
    expect((await failure(guard.check('http://169.254.169.254/'))).code).toBe('forbidden_address');
  });

  it('gives a network error for a name that does not resolve or has no address', async () => {
    const guard = new SsrfGuard(resolverOf({ 'empty.example.com': [] }), STRICT);
    expect((await failure(guard.check('https://missing.example.com/'))).code).toBe('network');
    expect((await failure(guard.check('https://empty.example.com/'))).code).toBe('network');
  });

  it('checks every call again, so a rebinding answer after a good answer is refused', async () => {
    const answers = [[PUBLIC], [{ address: '127.0.0.1', family: 4 as const }]];
    const resolver: DnsResolver = { resolve: vi.fn(async () => answers.shift() ?? []) };
    const guard = new SsrfGuard(resolver, STRICT);
    await expect(guard.check('https://rebind.example.com/')).resolves.toBeDefined();
    expect((await failure(guard.check('https://rebind.example.com/'))).code).toBe(
      'forbidden_address',
    );
  });

  it('refuses localhost with the system resolver', async () => {
    const guard = new SsrfGuard(systemDnsResolver, STRICT);
    expect((await failure(guard.check('https://localhost/'))).code).toBe('forbidden_address');
  });
});
