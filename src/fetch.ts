// Plain HTTP fetch. The honest UA goes first: some sites serve fabricated decoy pages to
// clients that claim to be a browser (tante.cc serves a small fake page to browser UAs). The browser
// UA exists for the opposite failure, where a site or network path mangles non-browser clients.
//
// Requests go through node:https rather than fetch(). Node's fetch() (undici) always offers
// ALPN "http/1.1" in its TLS hello, and Cloudflare blocks that handshake on some sites whatever
// the user agent says (petapixel.com, 2026-10-16: HTTP 403 for fetch(), 200 for node:https,
// curl --tls-max 1.2 and Python's urllib from the same address). node:https offers no ALPN.
import http from 'node:http';
import https from 'node:https';
import type { CookieJar } from './cookies.js';
import zlib from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertPublicAddress, byteLimits, checkedUrl, guardedLookup, NetworkPolicyError,
  type RequestPolicy,
} from './network-policy.js';
import { warn } from './util.js';
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_DECODED_BYTES, type RequestPolicy } from './network-policy.js';

export const VERSION = '0.5.2';
export const HONEST_UA = `wclip/${VERSION} (personal article clipper)`;
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

// A real HTML article page is essentially never smaller than this. Anything shorter is a
// stub, an error page or a decoy, so it is worth retrying with a different user agent.
export const MIN_PLAUSIBLE_HTML = 2048;

// A bare status code makes the user guess whether the tool or the site failed. Name the
// wall instead, and keep these phrases short enough to sit in parentheses.
export function statusHint(status: number): string | null {
  switch (status) {
    case 401: return 'login or subscription required';
    case 402: return 'payment required';
    case 403: return 'blocked by the site (bot wall or region lock)';
    case 407: return 'proxy authentication required';
    case 429: return 'rate limited, try again later';
    case 451: return 'unavailable for legal reasons';
    default: return null;
  }
}

// The last non-2xx answer, so the caller's final "could not fetch" error can name it.
let lastFailure: { status: number; url: string } | null = null;
export function lastHttpFailure(): { status: number; url: string } | null { return lastFailure; }
export function resetHttpFailures(): void { lastFailure = null; }

export interface Page {
  html: string;
  url: string; // final URL after redirects
  via: string; // how it was obtained, for diagnostics
  status?: number; // HTTP status, when there was one
  bytes?: number; // decoded body size
  ms?: number; // time spent fetching
}

function charsetOf(contentType: string | null, head: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader;
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 4096));
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8';
}

// Decode with the page's declared charset (e.g. windows-1250 on older Czech sites), not always UTF-8.
export function decodeBody(buf: Uint8Array, contentType: string | null): string {
  try {
    return new TextDecoder(charsetOf(contentType, buf)).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

const MAX_REDIRECTS = 10;

class HttpError extends Error {}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Uint8Array;
  url: string;
}

// Every decoding stage is bounded, not only the final output. A stacked encoding
// could otherwise expand enormously in an intermediate stage and shrink afterwards.
function limitBytes(limit: number, label: string): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new HttpError(`${label} exceeds ${limit} bytes`) : null, chunk);
    },
  });
}

async function readBody(res: http.IncomingMessage, policy: RequestPolicy, signal: AbortSignal): Promise<Buffer> {
  const { maxBytes, maxDecodedBytes } = byteLimits(policy);
  const length = res.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    res.destroy();
    throw new HttpError(`response Content-Length exceeds ${maxBytes} wire bytes`);
  }
  const encodings = (res.headers['content-encoding'] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (encodings.length > 4) {
    res.destroy();
    throw new HttpError('too many stacked Content-Encoding layers (maximum 4)');
  }
  const streams: (http.IncomingMessage | Transform | Writable)[] = [res, limitBytes(maxBytes, 'response wire body')];
  try {
    for (const encoding of encodings.reverse()) {
      let decoder: Transform;
      switch (encoding) {
        case 'identity': continue;
        case 'gzip': case 'x-gzip': decoder = zlib.createGunzip(); break;
        case 'deflate': decoder = zlib.createInflate(); break;
        case 'br': decoder = zlib.createBrotliDecompress(); break;
        default: throw new HttpError(`unsupported Content-Encoding ${encoding}`);
      }
      streams.push(decoder, limitBytes(maxDecodedBytes, 'decoded response body'));
    }
    const chunks: Buffer[] = [];
    let total = 0;
    streams.push(new Writable({
      write(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > maxDecodedBytes) return callback(new HttpError(`decoded response body exceeds ${maxDecodedBytes} bytes`));
        chunks.push(chunk);
        callback();
      },
    }));
    await pipeline(streams as [http.IncomingMessage, ...Transform[], Writable], { signal });
    return Buffer.concat(chunks, total);
  } finally {
    for (const stream of streams) stream.destroy();
  }
}

// Only TLS settings may be overridden: a caller-supplied lookup/agent/socketPath/
// createConnection/hostname must not sidestep the guarded connection destination.
function tlsSettings(tls: https.RequestOptions): https.RequestOptions {
  const keys = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'rejectUnauthorized', 'checkServerIdentity',
    'minVersion', 'maxVersion', 'ciphers', 'secureOptions', 'secureProtocol', 'ecdhCurve', 'sigalgs', 'crl', 'honorCipherOrder'] as const;
  return Object.fromEntries(keys.filter(key => tls[key] !== undefined).map(key => [key, tls[key]]));
}

// Cookies are attached per hop, from the jar, and any caller-supplied cookie field is
// discarded first: a redirect target must only receive the cookies that match it.
function hopHeaders(headers: Record<string, string>, target: URL, cookies?: CookieJar): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'cookie') out[k] = v;
  const cookie = cookies?.header(target) ?? null;
  if (cookie) out.cookie = cookie;
  return out;
}

// One GET with a single wall-clock deadline across DNS, redirects and decoding.
// node:https intentionally preserves its no-ALPN TLS hello; do not replace with fetch().
export async function get(url: string, headers: Record<string, string>, timeoutSec: number,
                          tls: https.RequestOptions = {}, policy: RequestPolicy = {},
                          cookies?: CookieJar): Promise<RawResponse> {
  byteLimits(policy);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec * 1000 > 0x7fffffff) {
    throw new HttpError('timeout must be a positive number of seconds (at most 2147483)');
  }
  let current = checkedUrl(url, policy);
  const controller = new AbortController();
  const timeoutError = new HttpError(`timed out after ${timeoutSec} s`);
  let request: http.ClientRequest | undefined;
  let response: http.IncomingMessage | undefined;
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    rejectDeadline(timeoutError);
    controller.abort(timeoutError);
    response?.destroy();
    request?.destroy();
  }, timeoutSec * 1000);
  const run = async (): Promise<RawResponse> => {
    for (let hops = 0; ; hops++) {
      const target = current;
      const mod = target.protocol === 'https:' ? https : http;
      response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = mod.get(target, {
          ...tlsSettings(tls), headers: hopHeaders(headers, target, cookies), agent: false,
          lookup: guardedLookup(policy), signal: controller.signal,
        }, resolve);
        request = req;
        req.on('error', reject);
        // Literal IPs bypass lookup; also verify the connected address as defense in
        // depth. No pooled sockets or alternate-family auto-selection may bypass it.
        req.on('socket', socket => {
          socket.once('connect', () => {
            try {
              if (!socket.remoteAddress) throw new NetworkPolicyError('connected socket has no remote address');
              assertPublicAddress(socket.remoteAddress, policy);
            } catch (error) { req.destroy(error as Error); }
          });
        });
      });
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        // Never drain an unbounded redirect body or let it retain an open stream.
        response.destroy();
        request?.destroy();
        if (hops >= MAX_REDIRECTS) throw new HttpError('too many redirects');
        current = checkedUrl(location, policy, target);
        continue;
      }
      const body = await readBody(response, policy, controller.signal);
      return { status, headers: response.headers, body, url: target.href };
    }
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    response?.destroy();
    request?.destroy();
  }
}

export async function fetchPage(url: string, ua: string, timeoutSec: number,
                                tls: https.RequestOptions = {}, policy: RequestPolicy = {},
                                cookies?: CookieJar): Promise<Page | null> {
  const label = ua === HONEST_UA ? 'honest UA' : 'browser UA';
  const started = Date.now();
  resetHttpFailures();
  try {
    const r = await get(url, {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en',
      'Accept-Encoding': 'gzip, deflate, br',
    }, timeoutSec, tls, policy, cookies);
    if (r.status < 200 || r.status > 299) {
      lastFailure = { status: r.status, url };
      const hint = statusHint(r.status);
      warn(`${label}: HTTP ${r.status} from ${url}${hint ? ` (${hint})` : ''}`);
      return null;
    }
    const ct = r.headers['content-type'] ?? null;
    if (ct && !/html|xml/i.test(ct)) {
      warn(`${label}: ${url} is ${ct.split(';')[0]}, not an HTML page`);
      return null;
    }
    return {
      html: decodeBody(r.body, ct), url: r.url, via: label,
      status: r.status, bytes: r.body.length, ms: Date.now() - started,
    };
  } catch (e) {
    warn(`${label}: ${(e as Error).message}`);
    return null;
  }
}
