// Opt-in JavaScript rendering through sandboxed Chromium. Keep Chromium's own
// HeadlessChrome UA: this is for rendering, not impersonating a desktop browser.
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { APIResponse, Browser, BrowserContext } from 'playwright-core';
import type { CookieJar } from './cookies.js';
import type { Page } from './fetch.js';
import { checkBrowserTarget, NetworkPolicyError, type RequestPolicy } from './network-policy.js';
import { envVar, warn } from './util.js';

const SYSTEM_BROWSERS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'brave-browser'];
const MAX_REDIRECTS = 10;
// Everything is fetched through route.fetch(), which buffers the whole body in process
// memory. Article text never needs audio/video streams or webfonts, so refuse them
// before a hostile page can allocate gigabytes.
const BLOCKED_RESOURCES = new Set(['media', 'font', 'manifest', 'texttrack']);
// Chromium's own UDP-based WebRTC paths bypass route interception entirely.
const WEBRTC_ARGS = [
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--enforce-webrtc-ip-permission-check',
];

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    // A relative PATH entry (".", "") would resolve against the current directory.
    if (!isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p); // stat, not existsSync: a directory is not an executable
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* not there, not executable */ }
  }
  return null;
}

// Subscriber cookies go into the browser context, not into route headers: Chromium then
// applies its own per-host and Secure rules, and the route handler never forwards them
// across origins. Only cookies matching the starting URL are loaded at all.
async function applyCookies(context: BrowserContext, url: string, cookies: CookieJar): Promise<void> {
  const matched = cookies.matches(url);
  const host = new URL(url).hostname;
  if (!matched.length) {
    warn(`headless browser: no cookie in the file matches ${host}`);
    return;
  }
  await context.addCookies(matched.map(c => ({
    name: c.name, value: c.value,
    domain: c.domain === '*' ? host : c.domain,
    path: c.path, secure: c.secure,
    expires: c.expires > 0 ? c.expires : -1, // Playwright's sentinel for a session cookie
  })));
}

export async function fetchWithBrowser(url: string, executable: string, timeoutSec: number,
                                       policy: Pick<RequestPolicy, 'allowPrivate'> = {},
                                       cookies?: CookieJar): Promise<Page | null> {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec * 1000 > 0x7fffffff) {
    warn('headless browser: timeout must be a positive, finite number of seconds');
    return null;
  }
  const started = Date.now();
  const deadlineAt = started + timeoutSec * 1000;
  let finished = false;
  let browser: Browser | undefined;
  const remaining = () => {
    const ms = deadlineAt - Date.now();
    if (finished || ms <= 0) throw new Error(`timed out after ${timeoutSec} s`);
    return Math.max(1, ms);
  };
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      finished = true;
      reject(new Error(`timed out after ${timeoutSec} s`));
      void browser?.close().catch(() => {});
    }, timeoutSec * 1000);
  });
  const run = async (): Promise<Page> => {
    const initial = await checkBrowserTarget(url, policy);
    remaining();
    let chromium: typeof import('playwright-core').chromium;
    try { ({ chromium } = await import('playwright-core')); }
    catch { throw new Error('playwright-core is not installed (npm install playwright-core)'); }
    // Candidates all require the sandbox. Never retry with --no-sandbox, including
    // when an executable is explicitly supplied or this process is running as root.
    const candidates: (string | undefined)[] = [];
    if (executable) candidates.push(executable);
    const envExe = envVar('CHROMIUM');
    if (envExe) candidates.push(envExe);
    candidates.push(undefined);
    for (const name of SYSTEM_BROWSERS) {
      const candidate = onPath(name);
      if (candidate) candidates.push(candidate);
    }
    const errors: string[] = [];
    for (const exe of [...new Set(candidates)]) {
      try {
        browser = await chromium.launch({ executablePath: exe, headless: true, chromiumSandbox: true, args: WEBRTC_ARGS, timeout: remaining() });
        // A launch that races the deadline must not leave a browser process behind.
        if (finished) { await browser.close(); throw new Error(`timed out after ${timeoutSec} s`); }
        break;
      } catch (error) {
        errors.push(`${exe ?? "Playwright's Chromium"}: ${(error as Error).message.split('\n')[0]}`);
        remaining();
      }
    }
    if (!browser) throw new Error('no sandboxed Chromium could be started; install Chromium with working sandbox support or set browser.executable.\n  ' + errors.join('\n  '));
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    if (cookies) await applyCookies(context, initial.href, cookies);
    const page = await context.newPage();
    let navigationRedirect: string | undefined;
    // WebSockets are not needed for an article snapshot. Block the handshake
    // entirely rather than permit unguarded WebSocket redirects or DNS lookups.
    if (typeof context.routeWebSocket !== 'function') throw new Error('Playwright lacks WebSocket interception; refusing an unguarded browser');
    await context.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'Article clipping blocks WebSockets' }));
    // IMPORTANT: route.continue() does NOT intercept later redirect hops. Fetch each
    // hop explicitly with redirects disabled, validate its Location, then fulfil.
    // Initial document redirects are re-navigated to preserve the final base URL.
    // DNS preflight is best effort: route.fetch/Chromium resolve independently and
    // are NOT protected against DNS rebinding. Use external egress filtering for
    // hostile pages. Routing is not a browser network sandbox (e.g. WebRTC).
    await context.route('**/*', async (route, request) => {
      let response: APIResponse | undefined;
      try {
        // Playwright's request object always reports a type; tolerate its absence so a
        // hand-built test double cannot silently skip the policy.
        if (BLOCKED_RESOURCES.has(request.resourceType?.() ?? '')) {
          await route.abort('blockedbyclient');
          return;
        }
        let target = await checkBrowserTarget(request.url(), policy);
        let method = request.method();
        let postData = request.postDataBuffer() ?? undefined;
        const headers = { ...await request.allHeaders() };
        for (let hops = 0; ; hops++) {
          response = await route.fetch({ url: target.href, method, postData, headers, maxRedirects: 0, timeout: remaining() });
          const status = response.status();
          const location = response.headers().location;
          if (status >= 300 && status < 400 && location) {
            if (hops >= MAX_REDIRECTS) throw new NetworkPolicyError('too many browser resource redirects');
            const next = await checkBrowserTarget(location, policy, target);
            await response.dispose();
            response = undefined;
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
              navigationRedirect = next.href;
              await route.abort('aborted');
              return;
            }
            if (next.origin !== target.origin) {
              delete headers.authorization;
              delete headers.cookie;
              delete headers['proxy-authorization'];
            }
            if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
              method = 'GET';
              postData = undefined;
              delete headers['content-length'];
              delete headers['content-type'];
            }
            target = next;
            continue;
          }
          remaining();
          await route.fulfill({ response });
          return;
        }
      } catch (error) {
        if (!finished) warn(`headless browser blocked request: ${(error as Error).message.split('\n')[0]}`);
        await route.abort('blockedbyclient').catch(() => {});
      } finally { await response?.dispose().catch(() => {}); }
    });
    let target = initial.href;
    for (let hops = 0; ; hops++) {
      navigationRedirect = undefined;
      try { await page.goto(target, { waitUntil: 'load', timeout: remaining() }); }
      catch (error) { if (!navigationRedirect) throw error; }
      if (!navigationRedirect) break;
      if (hops >= MAX_REDIRECTS) throw new NetworkPolicyError('too many browser document redirects');
      target = navigationRedirect;
    }
    // Rendering gets only the time remaining in the same overall deadline.
    await page.waitForLoadState('networkidle', { timeout: Math.min(5000, remaining()) }).catch(() => {});
    remaining();
    const html = await page.content();
    return { html, url: page.url(), via: 'headless browser', ms: Date.now() - started };
  };
  try { return await Promise.race([run(), deadline]); }
  catch (error) {
    warn(`headless browser: ${(error as Error).message}`);
    return null;
  } finally {
    finished = true;
    clearTimeout(timer!);
    await browser?.close().catch(() => {});
  }
}
