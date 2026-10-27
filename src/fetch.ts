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
import zlib from 'node:zlib';
import { warn } from './util.js';

export const VERSION = '0.3.1';
export const HONEST_UA = `wclip/${VERSION} (personal article clipper)`;
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

// A real HTML article page is essentially never smaller than this. Anything shorter is a
// stub, an error page or a decoy, so it is worth retrying with a different user agent.
export const MIN_PLAUSIBLE_HTML = 2048;

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

function decompress(buf: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    case 'br': return zlib.brotliDecompressSync(buf);
    default: return buf;
  }
}

// One GET, following redirects. `tls` lets tests trust a self-signed certificate.
export function get(url: string, headers: Record<string, string>, timeoutSec: number,
                    tls: https.RequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req?.destroy(new HttpError(`timed out after ${timeoutSec} s`)); }, timeoutSec * 1000);
    let req: http.ClientRequest | undefined;
    const done = (fn: () => void) => { clearTimeout(timer); fn(); };
    const go = (u: URL, hops: number) => {
      const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
      if (!mod) return done(() => reject(new HttpError(`unsupported URL scheme ${u.protocol}`)));
      req = mod.get(u, { headers, ...(u.protocol === 'https:' ? tls : {}) }, (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc) {
          res.resume();
          if (hops >= MAX_REDIRECTS) return done(() => reject(new HttpError('too many redirects')));
          return go(new URL(loc, u), hops + 1);
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (e) => done(() => reject(e)));
        res.on('end', () => done(() => {
          try {
            resolve({ status, headers: res.headers, body: decompress(Buffer.concat(chunks), res.headers['content-encoding']), url: u.href });
          } catch (e) {
            reject(e);
          }
        }));
      });
      req.on('error', (e) => done(() => reject(e)));
    };
    try {
      go(new URL(url), 0);
    } catch (e) {
      done(() => reject(e));
    }
  });
}

export async function fetchPage(url: string, ua: string, timeoutSec: number,
                                tls: https.RequestOptions = {}): Promise<Page | null> {
  const label = ua === HONEST_UA ? 'honest UA' : 'browser UA';
  const started = Date.now();
  try {
    const r = await get(url, {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en',
      'Accept-Encoding': 'gzip, deflate, br',
    }, timeoutSec, tls);
    if (r.status < 200 || r.status > 299) {
      warn(`${label}: HTTP ${r.status} from ${url}`);
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
