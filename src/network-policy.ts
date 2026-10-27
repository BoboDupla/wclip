// Shared outbound-network policy. URL parsing canonicalizes alternate IPv4 spellings
// (integer, octal, hexadecimal and short forms) before the address is classified.
import dns from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export interface RequestPolicy {
  allowPrivate?: boolean;
  maxBytes?: number;
  maxDecodedBytes?: number;
}

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_DECODED_BYTES = 20 * 1024 * 1024;

export class NetworkPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'NetworkPolicyError'; }
}

const V4_DENY: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  // Azure's host virtual IP exposes platform services, despite its public-looking address.
  ['168.63.129.16', 32],
];
const v4Number = (address: string): number => address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const V4_RANGES = V4_DENY.map(([base, bits]) => ({ base: v4Number(base), size: 2 ** (32 - bits) }));

function v6Number(address: string): bigint {
  // isIP() has already validated the grammar, including the optional dotted IPv4 tail.
  address = address.toLowerCase().replace(/\d+\.\d+\.\d+\.\d+$/, tail => {
    const n = v4Number(tail);
    return `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  });
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return parts.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
}
const inV6 = (n: bigint, base: string, bits: number): boolean => n >> BigInt(128 - bits) === v6Number(base) >> BigInt(128 - bits);

// Conservative public-unicast allowlist: reject special-use, transition/tunnelling,
// documentation and future/reserved space as well as private/local/multicast space.
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false; // scoped addresses are never public targets
  const family = isIP(address);
  if (family === 4) {
    const n = v4Number(address);
    return !V4_RANGES.some(range => n >= range.base && n < range.base + range.size);
  }
  if (family !== 6) return false;
  const n = v6Number(address);
  if (n >> 32n === 0xffffn) {
    const v4 = Number(n & 0xffffffffn);
    return isPublicAddress([24, 16, 8, 0].map(shift => (v4 >>> shift) & 255).join('.'));
  }
  return inV6(n, '2000::', 3) && !inV6(n, '2001::', 23) &&
    !inV6(n, '2001:db8::', 32) && !inV6(n, '2002::', 16) && !inV6(n, '3fff::', 20);
}

export function assertPublicAddress(address: string, policy: Pick<RequestPolicy, 'allowPrivate'> = {}): void {
  if (policy.allowPrivate !== true && !isPublicAddress(address)) {
    throw new NetworkPolicyError(`blocked non-public network address ${address} (use --allow-private only for trusted local targets)`);
  }
}

export function checkedUrl(input: string | URL, policy: Pick<RequestPolicy, 'allowPrivate'> = {}, previous?: URL): URL {
  let url: URL;
  try { url = new URL(input, previous); }
  catch { throw new NetworkPolicyError('invalid HTTP URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkPolicyError(`unsupported URL scheme ${url.protocol}; only HTTP(S) is allowed`);
  }
  const spelling = String(input).trim().replace(/[\t\r\n]/g, '');
  const authority = /^(?:https?:[\\/]*|[\\/]{2,})([^\\/?#]*)/i.exec(spelling)?.[1];
  if (url.username || url.password || authority?.includes('@')) {
    throw new NetworkPolicyError('URL credentials are not allowed');
  }
  if (previous?.protocol === 'https:' && url.protocol === 'http:') {
    throw new NetworkPolicyError('blocked HTTPS-to-HTTP redirect downgrade');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) assertPublicAddress(host, policy);
  if (policy.allowPrivate !== true && /(^|\.)(localhost|local|internal)\.?$/i.test(host)) {
    throw new NetworkPolicyError(`blocked non-public hostname ${host}`);
  }
  return url;
}

// This lookup is used by the actual Node connection, not by a separate preflight.
// Reject mixed public/private DNS answers; no second unvalidated lookup may occur.
export function guardedLookup(policy: Pick<RequestPolicy, 'allowPrivate'> = {}): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true, family: options.family }, (error, addresses) => {
      if (error) return callback(error, '', 4);
      try {
        if (!addresses.length) throw new NetworkPolicyError(`DNS returned no addresses for ${hostname}`);
        for (const record of addresses) assertPublicAddress(record.address, policy);
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      } catch (error) { callback(error as NodeJS.ErrnoException, '', 4); }
    });
  };
}

// Browser DNS preflight is only best effort: Chromium resolves independently.
// It DOES NOT pin Chromium's connection address or prevent DNS rebinding. Full
// browser SSRF isolation requires an external filtering proxy/network namespace.
export async function checkBrowserTarget(input: string | URL, policy: Pick<RequestPolicy, 'allowPrivate'> = {}, previous?: URL): Promise<URL> {
  const url = checkedUrl(input, policy, previous);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) {
    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (!addresses.length) throw new NetworkPolicyError(`DNS returned no addresses for ${host}`);
    for (const record of addresses) assertPublicAddress(record.address, policy);
  }
  return url;
}

export function byteLimits(policy: RequestPolicy): { maxBytes: number; maxDecodedBytes: number } {
  const result = {
    maxBytes: policy.maxBytes ?? DEFAULT_MAX_BYTES,
    maxDecodedBytes: policy.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES,
  };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new NetworkPolicyError(`${key} must be a positive safe integer`);
  }
  return result;
}
