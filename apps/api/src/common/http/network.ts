import { BlockList, isIP } from 'node:net';

/**
 * Address checks without a dependency (`node:net` BlockList).
 * `request.ip` is the client address after the trusted proxies (see `TRUST_PROXY`).
 */

function toFamily(address: string): 'ipv4' | 'ipv6' | null {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
}

/** `::ffff:10.0.0.1` is the IPv4 address `10.0.0.1`. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
}

const PRIVATE_RANGES: [string, number, 'ipv4' | 'ipv6'][] = [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  // Carrier-grade NAT range. Tailscale uses it for the operators network.
  ['100.64.0.0', 10, 'ipv4'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
];

const privateList = new BlockList();
for (const [network, prefix, family] of PRIVATE_RANGES) {
  privateList.addSubnet(network, prefix, family);
}

/** True for a loopback, private (RFC 1918, RFC 4193), link-local, or CGNAT address. */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = normalizeAddress(address);
  const family = toFamily(normalized);
  return family !== null && privateList.check(normalized, family);
}

/**
 * A matcher for a list of addresses and CIDR ranges (`203.0.113.7`, `198.51.100.0/24`, `2001:db8::/32`).
 * An entry that is not valid throws, so a bad `allowedIps` value shows at once.
 */
export function addressMatcher(
  entries: readonly string[],
): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const [network = '', prefixText] = entry.split('/');
    const family = toFamily(network);
    if (!family) {
      throw new Error(`Invalid address entry: ${entry}`);
    }
    if (prefixText === undefined) {
      list.addAddress(network, family);
      continue;
    }
    const prefix = Number(prefixText);
    const max = family === 'ipv4' ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`Invalid address entry: ${entry}`);
    }
    list.addSubnet(network, prefix, family);
  }
  return (address) => {
    if (!address) {
      return false;
    }
    const normalized = normalizeAddress(address);
    const family = toFamily(normalized);
    return family !== null && list.check(normalized, family);
  };
}
