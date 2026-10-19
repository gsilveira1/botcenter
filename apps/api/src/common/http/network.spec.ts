import { describe, expect, it } from 'vitest';
import { generateRequestId } from './request-id';
import { addressMatcher, isPrivateAddress } from './network';
import type { IncomingMessage } from 'node:http';

describe('isPrivateAddress', () => {
  it('accepts loopback, private, link-local, CGNAT, and mapped IPv4 addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '169.254.1.1',
      '100.100.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it('refuses public and invalid addresses', () => {
    for (const address of [
      '203.0.113.1',
      '8.8.8.8',
      '172.32.0.1',
      '2001:db8::1',
      'not-an-ip',
      '',
      undefined,
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});

describe('addressMatcher', () => {
  it('matches single addresses and CIDR ranges of both families', () => {
    const matches = addressMatcher(['203.0.113.7', '198.51.100.0/24', '2001:db8::/32']);
    expect(matches('203.0.113.7')).toBe(true);
    expect(matches('198.51.100.200')).toBe(true);
    expect(matches('::ffff:198.51.100.1')).toBe(true);
    expect(matches('2001:db8::5')).toBe(true);
    expect(matches('203.0.113.8')).toBe(false);
    expect(matches(undefined)).toBe(false);
  });

  it('throws on an invalid entry', () => {
    expect(() => addressMatcher(['300.1.1.1'])).toThrow();
    expect(() => addressMatcher(['10.0.0.0/33'])).toThrow();
  });
});

describe('generateRequestId', () => {
  const request = (value?: string) =>
    ({ headers: value === undefined ? {} : { 'x-request-id': value } }) as IncomingMessage;

  it('keeps a safe X-Request-Id and replaces an unsafe or missing one', () => {
    expect(generateRequestId(request('abc-123'))).toBe('abc-123');
    expect(generateRequestId(request('bad value\n'))).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateRequestId(request())).toMatch(/^[0-9a-f-]{36}$/);
  });
});
