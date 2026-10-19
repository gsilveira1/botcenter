import { isIP } from 'node:net';

/**
 * The address policy of the SSRF guard. A client URL must not reach the internal network, the host, or a
 * cloud metadata service. The check works on the bytes of the address (no `BlockList`), so that every
 * text form of an address (`::ffff:7f00:1`, `::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1`) gives the same
 * result.
 */

export type IpFamily = 4 | 6;

export interface ParsedIp {
  family: IpFamily;
  bytes: Uint8Array;
}

interface Range {
  family: IpFamily;
  bytes: Uint8Array;
  bits: number;
  label: string;
}

/** Parses an IPv4 or IPv6 address (with or without brackets). Returns `null` for a host name. */
export function parseIp(text: string): ParsedIp | null {
  const address = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const version = isIP(address);
  if (version === 4) {
    return { family: 4, bytes: Uint8Array.from(address.split('.').map(Number)) };
  }
  if (version === 6) {
    return { family: 6, bytes: parseIpv6(address) };
  }
  return null;
}

/** `isIP` validated the text before this call, so the parts are well formed. */
function parseIpv6(address: string): Uint8Array {
  const withoutZone = address.split('%')[0] ?? address;
  const [head = '', tail] = withoutZone.split('::');
  const toGroups = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (group.includes('.')) {
            const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
            return [(a << 8) | b, (c << 8) | d];
          }
          return [parseInt(group, 16)];
        });
  const headGroups = toGroups(head);
  const tailGroups = tail === undefined ? [] : toGroups(tail);
  const zeros = new Array<number>(8 - headGroups.length - tailGroups.length).fill(0);
  const groups = [...headGroups, ...zeros, ...tailGroups];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function range(cidr: string, label: string): Range {
  const [network = '', bits = ''] = cidr.split('/');
  const parsed = parseIp(network);
  if (!parsed) {
    throw new Error(`Invalid range: ${cidr}`);
  }
  return { ...parsed, bits: Number(bits), label };
}

/** The refused ranges. The label goes to the logs and to the error message. */
const FORBIDDEN_RANGES: readonly Range[] = [
  // Cloud metadata services first: `allowPrivate` (tests) never opens them.
  range('169.254.169.254/32', 'metadata'),
  range('169.254.170.2/32', 'metadata'),
  range('100.100.100.200/32', 'metadata'),
  range('fd00:ec2::254/128', 'metadata'),
  // Azure WireServer. It is a public address.
  range('168.63.129.16/32', 'metadata'),
  range('0.0.0.0/8', 'unspecified'),
  range('10.0.0.0/8', 'private'),
  range('100.64.0.0/10', 'cgnat'),
  range('127.0.0.0/8', 'loopback'),
  range('169.254.0.0/16', 'link_local'),
  range('172.16.0.0/12', 'private'),
  range('192.0.0.0/24', 'reserved'),
  range('192.0.2.0/24', 'documentation'),
  range('192.88.99.0/24', 'reserved'),
  range('192.168.0.0/16', 'private'),
  range('198.18.0.0/15', 'reserved'),
  range('198.51.100.0/24', 'documentation'),
  range('203.0.113.0/24', 'documentation'),
  range('224.0.0.0/4', 'multicast'),
  range('240.0.0.0/4', 'reserved'),
  range('::/128', 'unspecified'),
  range('::1/128', 'loopback'),
  // IPv4-compatible addresses (deprecated). `::ffff:0:0/96` (IPv4-mapped) is checked as IPv4 below.
  range('::/96', 'reserved'),
  range('64:ff9b::/96', 'nat64'),
  range('64:ff9b:1::/48', 'nat64'),
  range('100::/64', 'reserved'),
  range('2001::/32', 'teredo'),
  range('2001:db8::/32', 'documentation'),
  range('2002::/16', '6to4'),
  // Unique local addresses.
  range('fc00::/7', 'private'),
  range('fe80::/10', 'link_local'),
  range('fec0::/10', 'reserved'),
  range('ff00::/8', 'multicast'),
];

function inRange(ip: ParsedIp, candidate: Range): boolean {
  if (ip.family !== candidate.family) {
    return false;
  }
  const fullBytes = Math.floor(candidate.bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (ip.bytes[index] !== candidate.bytes[index]) {
      return false;
    }
  }
  const rest = candidate.bits % 8;
  if (rest === 0) {
    return true;
  }
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((ip.bytes[fullBytes] ?? 0) & mask) === ((candidate.bytes[fullBytes] ?? 0) & mask);
}

/** `::ffff:a.b.c.d` is the IPv4 address `a.b.c.d`. */
function unmapIpv4(ip: ParsedIp): ParsedIp {
  if (ip.family !== 6) {
    return ip;
  }
  const isMapped =
    ip.bytes.subarray(0, 10).every((byte) => byte === 0) &&
    ip.bytes[10] === 0xff &&
    ip.bytes[11] === 0xff;
  return isMapped ? { family: 4, bytes: ip.bytes.slice(12) } : ip;
}

/**
 * Returns the label of the forbidden range of the address (`private`, `loopback`, `metadata`, ...), or
 * `null` when the address is a public unicast address. A text that is not an IP address gives `invalid`.
 */
export function forbiddenRangeOf(address: string): string | null {
  const parsed = parseIp(address);
  if (!parsed) {
    return 'invalid';
  }
  const ip = unmapIpv4(parsed);
  return FORBIDDEN_RANGES.find((candidate) => inRange(ip, candidate))?.label ?? null;
}
