// Subscriber cookies, for sites whose content is only served to a logged-in session
// (WSJ and friends answer 401 to everyone else, whatever the user agent says).
//
// Scope rules, all deliberate:
// - A cookie is only sent to the host it belongs to. A redirect to another host therefore
//   drops it, and a wildcard entry from a bare "name=value" file is the only thing that
//   travels anywhere.
// - The browser fetcher does not pass these through request headers: it loads them into a
//   fresh browser context so Chromium applies its own same-origin handling.
// - Nothing in this module prints a cookie value. Diagnostics carry counts and names only.
import { readTextFileLimited } from './files.js';

export const MAX_COOKIES = 2000;
export const MAX_COOKIE_FILE_BYTES = 1024 * 1024;

// RFC 6265 token, i.e. what a cookie name may be.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Domain entries in a Netscape file are hostnames (an optional leading dot means
// "include subdomains"). '*' is our own wildcard for a bare name=value line.
const COOKIE_DOMAIN = /^\*$|^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export interface Cookie {
  name: string;
  value: string;
  domain: string; // lowercase, no leading dot; '*' = any host
  path: string;
  secure: boolean;
  expires: number; // seconds since epoch; 0 = session cookie
  hostOnly: boolean; // true = this exact host only, not its subdomains
}

export interface CookieJar {
  readonly count: number;
  // Cookies that may be sent to this URL, in RFC 6265 precedence order.
  matches(url: string | URL): Cookie[];
  // A ready Cookie header value, or null when nothing matches.
  header(url: string | URL): string | null;
}

function usable(name: string, value: string): boolean {
  // Reject anything that could break out of the header or smuggle a second field.
  return COOKIE_NAME.test(name) && !/[;\r\n\u0000-\u001f\u007f]/.test(value) && value.length <= 4096;
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/^\./, '').toLowerCase();
}

function parseExpires(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) return 0;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

// Netscape cookies.txt (curl, yt-dlp and most browser exporters) plus bare name=value lines.
export function parseCookieFile(text: string): Cookie[] {
  const byKey = new Map<string, Cookie>();
  for (const raw of text.split(/\r?\n/)) {
    if (byKey.size >= MAX_COOKIES) break;
    // "#HttpOnly_" lines are data, every other '#' line is a comment.
    let line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
    if (!raw.startsWith('#HttpOnly_') && line.trimStart().startsWith('#')) continue;
    if (!line.trim()) continue;
    const fields = line.split('\t');
    let cookie: Cookie | null = null;
    if (fields.length >= 7) {
      const [domain, includeSubdomains, path, secure, expires, name, value] = fields;
      const host = normalizeDomain(domain ?? '');
      if (!host || !COOKIE_DOMAIN.test(host)) continue;
      if (!usable(name ?? '', value ?? '')) continue;
      cookie = {
        name, value, domain: host,
        path: path?.startsWith('/') ? path : '/',
        secure: String(secure).toUpperCase() === 'TRUE',
        expires: parseExpires(expires ?? '0'),
        // "TRUE" in the include-subdomains column means domain cookies apply to subdomains too.
        hostOnly: String(includeSubdomains).toUpperCase() !== 'TRUE',
      };
    } else {
      const bare = /^([^=\s;]+)=(\S*)$/.exec(line.trim());
      if (!bare) continue;
      const [, name, value] = bare;
      if (!usable(name, value)) continue;
      cookie = { name, value, domain: '*', path: '/', secure: false, expires: 0, hostOnly: false };
    }
    // Last one wins, matching how a browser resolves duplicates read in file order.
    byKey.set(`${cookie.name}\t${cookie.domain}\t${cookie.path}`, cookie);
  }
  return [...byKey.values()];
}

function requestHost(url: string | URL): { host: string; path: string; secure: boolean } | null {
  let parsed: URL;
  try { parsed = typeof url === 'string' ? new URL(url) : url; } catch { return null; }
  return { host: parsed.hostname.toLowerCase(), path: parsed.pathname || '/', secure: parsed.protocol === 'https:' };
}

// RFC 6265 §5.1.4: a request path matches when it equals the cookie path or continues past a '/'.
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === '/') return true;
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

export function cookieJar(cookies: Cookie[]): CookieJar {
  const all = cookies.slice(0, MAX_COOKIES);
  const matches = (url: string | URL): Cookie[] => {
    const target = requestHost(url);
    if (!target) return [];
    const now = Date.now() / 1000;
    return all
      .filter(c => {
        if (c.expires > 0 && c.expires <= now) return false;
        if (c.secure && !target.secure) return false;
        if (!pathMatches(target.path, c.path)) return false;
        if (c.domain === '*') return true;
        return target.host === c.domain || (!c.hostOnly && target.host.endsWith(`.${c.domain}`));
      })
      // Longer paths first, so the most specific cookie wins a duplicate name.
      .sort((a, b) => b.path.length - a.path.length);
  };
  return {
    count: all.length,
    matches,
    header(url) {
      const applicable = matches(url);
      return applicable.length ? applicable.map(c => `${c.name}=${c.value}`).join('; ') : null;
    },
  };
}

export function emptyJar(): CookieJar {
  return cookieJar([]);
}

// Throws a message safe to show the user; it never contains file contents.
export function loadCookieJar(path: string): CookieJar {
  const text = readTextFileLimited(path, MAX_COOKIE_FILE_BYTES);
  return cookieJar(parseCookieFile(text));
}
