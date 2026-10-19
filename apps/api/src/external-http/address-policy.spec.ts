import { describe, expect, it } from 'vitest';
import { forbiddenRangeOf, parseIp } from './address-policy';

describe('forbiddenRangeOf', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.10', 'private'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['169.254.10.20', 'link_local'],
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['168.63.129.16', 'metadata'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.254', 'cgnat'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['192.0.0.170', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['203.0.113.9', 'documentation'],
  ])('refuses the IPv4 address %s (%s)', (address, label) => {
    expect(forbiddenRangeOf(address)).toBe(label);
  });

  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['ff02::1', 'multicast'],
    ['fec0::1', 'reserved'],
    ['::127.0.0.1', 'reserved'],
    ['64:ff9b::a00:1', 'nat64'],
    ['64:ff9b::8.8.8.8', 'nat64'],
    ['2001:db8::1', 'documentation'],
    ['2001:0:4136:e378::1', 'teredo'],
    ['2002:c000:204::1', '6to4'],
    ['100::1', 'reserved'],
  ])('refuses the IPv6 address %s (%s)', (address, label) => {
    expect(forbiddenRangeOf(address)).toBe(label);
  });

  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
    ['::ffff:10.1.2.3', 'private'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:192.168.0.1', 'private'],
    ['[::ffff:169.254.1.1]', 'link_local'],
  ])('refuses the IPv4-mapped address %s as its IPv4 address (%s)', (address, label) => {
    expect(forbiddenRangeOf(address)).toBe(label);
  });

  it.each([
    '8.8.8.8',
    '93.184.215.14',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('accepts the public address %s', (address) => {
    expect(forbiddenRangeOf(address)).toBeNull();
  });

  it('marks a text that is not an address as invalid', () => {
    expect(forbiddenRangeOf('example.com')).toBe('invalid');
    expect(forbiddenRangeOf('256.1.1.1')).toBe('invalid');
  });
});

describe('parseIp', () => {
  it('parses IPv4, IPv6, brackets, and an embedded IPv4 tail', () => {
    expect(parseIp('1.2.3.4')).toEqual({ family: 4, bytes: Uint8Array.from([1, 2, 3, 4]) });
    expect(parseIp('[::1]')?.bytes.at(15)).toBe(1);
    expect(Array.from(parseIp('::ffff:1.2.3.4')?.bytes ?? []).slice(10)).toEqual([
      0xff, 0xff, 1, 2, 3, 4,
    ]);
    expect(parseIp('hooks.example.com')).toBeNull();
  });
});
