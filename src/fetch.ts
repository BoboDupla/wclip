// Plain HTTP fetch. The honest UA goes first: some sites serve fabricated decoy pages to
// clients that claim to be a browser (tante.cc, confirmed in bakeoff/decoy/). The browser
// UA exists for the opposite failure, where a site or network path mangles non-browser clients.
import { warn } from './util.js';

export const VERSION = '0.2.0';
export const HONEST_UA = `wclip/${VERSION} (personal article clipper)`;
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

// A real HTML article page is essentially never smaller than this. Anything shorter is a
// stub, an error page or a decoy, so it is worth retrying with a different user agent.
export const MIN_PLAUSIBLE_HTML = 2048;

export interface Page {
  html: string;
  url: string; // final URL after redirects
  via: string; // how it was obtained, for diagnostics
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

export async function fetchPage(url: string, ua: string, timeoutSec: number): Promise<Page | null> {
  const label = ua === HONEST_UA ? 'honest UA' : 'browser UA';
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (!r.ok) {
      warn(`${label}: HTTP ${r.status} from ${url}`);
      return null;
    }
    const ct = r.headers.get('content-type');
    if (ct && !/html|xml/i.test(ct)) {
      warn(`${label}: ${url} is ${ct.split(';')[0]}, not an HTML page`);
      return null;
    }
    const html = decodeBody(new Uint8Array(await r.arrayBuffer()), ct);
    return { html, url: r.url || url, via: label };
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    warn(`${label}: ${err.cause?.message ?? err.message}`);
    return null;
  }
}
