import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fetchWithBrowser } from '../dist/browser.js';

let playwright;
try { playwright = await import('playwright-core'); } catch {}
const chromiumPath = process.env.WCLIP_CHROMIUM ?? [
  playwright?.chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].find(path => path && existsSync(path));

// These unit tests drive the actual browser policy/routing code with controlled
// Playwright request objects; real sandboxed rendering is separately tested below.
function fakeBrowser(t, options = {}) {
  const state = { launches: [], contexts: [], fetches: [], aborted: [], fulfilled: [], closes: 0, wsClosed: [] };
  const page = {
    mainFrame: () => page,
    url: () => state.currentUrl,
    content: async () => '<html><body>Rendered test page</body></html>',
    waitForLoadState: async () => {},
    goto: async url => {
      state.currentUrl = url;
      const request = makeRequest(url, true);
      const route = makeRoute(url);
      await state.routeHandler(route, request);
      if (route.aborted) throw new Error('navigation aborted');
      if (options.onPage) await options.onPage(state, makeRequest, makeRoute);
    },
  };
  function makeRequest(url, navigation = false, type = 'document') {
    return {
      url: () => url, method: () => 'GET', postDataBuffer: () => null,
      resourceType: () => type,
      allHeaders: async () => ({ 'user-agent': 'HeadlessChrome/test' }),
      isNavigationRequest: () => navigation, frame: () => page,
    };
  }
  function makeRoute(url) {
    return {
      aborted: false,
      abort: async function () { this.aborted = true; state.aborted.push(url); },
      fulfill: async () => { state.fulfilled.push(url); },
      fetch: async opts => {
        state.fetches.push(opts);
        const result = options.responses?.[opts.url] ?? {};
        return { status: () => result.status ?? 200, headers: () => result.headers ?? {}, dispose: async () => {} };
      },
    };
  }
  const context = {
    newPage: async () => page,
    route: async (_pattern, handler) => { state.routeHandler = handler; },
    routeWebSocket: async (_pattern, handler) => { state.wsHandler = handler; },
  };
  t.mock.method(playwright.chromium, 'launch', async opts => {
    state.launches.push(opts);
    if (options.launchError) throw new Error(options.launchError);
    return {
      newContext: async opts => { state.contexts.push(opts); return context; },
      close: async () => { state.closes++; },
    };
  });
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  return state;
}

test('browser denies private addresses and invalid schemes before attempting launch', async t => {
  let calls = 0;
  if (playwright) t.mock.method(playwright.chromium, 'launch', async () => { calls++; throw new Error('must not launch'); });
  for (const url of ['http://127.1/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/', 'http://user:secret@example.org/', 'file:///etc/passwd']) {
    assert.equal(await fetchWithBrowser(url, '', 0.5), null);
  }
  assert.equal(calls, 0);
});

test('browser sandbox, isolated context and blocked WebSockets are explicit', { skip: !playwright }, async t => {
  const state = fakeBrowser(t);
  assert.ok(await fetchWithBrowser('https://article.example/', '', 1));
  assert.equal(state.launches.length, 1);
  assert.equal(state.launches[0].chromiumSandbox, true);
  assert.equal(state.launches[0].headless, true);
  assert.ok(state.launches[0].args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'),
    'WebRTC UDP paths bypass route interception and must be disabled');
  assert.deepEqual(state.contexts, [{ acceptDownloads: false, serviceWorkers: 'block' }]);
  assert.equal(state.fetches[0].maxRedirects, 0, 'Playwright automatic redirects must be disabled');
  assert.equal(state.fetches[0].headers['user-agent'], 'HeadlessChrome/test');
  let connected = false;
  await state.wsHandler({
    connectToServer: () => { connected = true; },
    close: async opts => state.wsClosed.push(opts),
  });
  assert.equal(connected, false);
  assert.equal(state.wsClosed[0].code, 1008);
  assert.ok(state.closes > 0);
});

test('browser blocks private subresources and private resource redirects before issuing them', { skip: !playwright }, async t => {
  const privateUrl = 'https://169.254.169.254/latest/meta-data/';
  const publicResource = 'https://assets.example/redirect';
  const state = fakeBrowser(t, {
    responses: { [publicResource]: { status: 302, headers: { location: privateUrl } } },
    onPage: async (state, request, route) => {
      await state.routeHandler(route(privateUrl), request(privateUrl));
      await state.routeHandler(route(publicResource), request(publicResource));
    },
  });
  assert.ok(await fetchWithBrowser('https://article.example/', '', 1));
  assert.deepEqual(state.fetches.map(x => x.url), ['https://article.example/', publicResource]);
  assert.deepEqual(state.aborted, [privateUrl, publicResource]);
});

test('browser refuses media, font and manifest subresources before fetching them', { skip: !playwright }, async t => {
  const media = 'https://assets.example/movie.mp4';
  const font = 'https://assets.example/font.woff2';
  const manifest = 'https://assets.example/app.webmanifest';
  const image = 'https://assets.example/pic.jpg';
  const state = fakeBrowser(t, {
    onPage: async (state, request, route) => {
      await state.routeHandler(route(media), request(media, false, 'media'));
      await state.routeHandler(route(font), request(font, false, 'font'));
      await state.routeHandler(route(manifest), request(manifest, false, 'manifest'));
      await state.routeHandler(route(image), request(image, false, 'image'));
    },
  });
  assert.ok(await fetchWithBrowser('https://article.example/', '', 1));
  // route.fetch buffers whole bodies in this process, so unbounded streams never start.
  assert.deepEqual(state.fetches.map(x => x.url), ['https://article.example/', image]);
  assert.deepEqual(state.aborted, [media, font, manifest]);
});

test('browser document redirect is validated and navigated explicitly; final URL survives', { skip: !playwright }, async t => {
  const first = 'https://article.example/first';
  const final = 'https://article.example/final';
  const state = fakeBrowser(t, { responses: { [first]: { status: 302, headers: { location: '/final' } } } });
  const page = await fetchWithBrowser(first, '', 1);
  assert.equal(page?.url, final);
  assert.deepEqual(state.fetches.map(x => x.url), [first, final]);
});

test('browser blocks document redirect downgrade even with private opt-in', { skip: !playwright }, async t => {
  const first = 'https://article.example/first';
  const state = fakeBrowser(t, { responses: { [first]: { status: 302, headers: { location: 'http://127.0.0.1/' } } } });
  assert.equal(await fetchWithBrowser(first, '', 1, { allowPrivate: true }), null);
  assert.deepEqual(state.fetches.map(x => x.url), [first]);
});

test('browser follows resource redirects one guarded hop at a time', { skip: !playwright }, async t => {
  const first = 'https://assets.example/first';
  const final = 'https://assets.example/final';
  const state = fakeBrowser(t, {
    responses: { [first]: { status: 302, headers: { location: '/final' } } },
    onPage: async (state, request, route) => state.routeHandler(route(first), request(first)),
  });
  assert.ok(await fetchWithBrowser('https://article.example/', '', 1));
  assert.deepEqual(state.fetches.map(x => x.url), ['https://article.example/', first, final]);
  assert.ok(state.fetches.every(x => x.maxRedirects === 0));
});

test('sandbox startup failure never retries unsandboxed', { skip: !playwright }, async t => {
  const state = fakeBrowser(t, { launchError: 'No usable sandbox!' });
  assert.equal(await fetchWithBrowser('https://article.example/', '/unusable/chromium', 1), null);
  assert.ok(state.launches.length > 0);
  assert.ok(state.launches.every(x => x.chromiumSandbox === true));
  assert.ok(state.launches.every(x => !x.args?.includes('--no-sandbox')));
});

test('browser timeout includes DNS preflight stalls', async t => {
  t.mock.method(dns.promises, 'lookup', () => new Promise(() => {}));
  const started = performance.now();
  assert.equal(await fetchWithBrowser('https://stalled.example/', '', 0.05), null);
  assert.ok(performance.now() - started < 1000);
});

test('real sandboxed Chromium renders JS and follows guarded document redirects', { skip: !chromiumPath && 'no Chromium found' }, async () => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/page' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><div id="result">stub</div><script>document.querySelector("#result").textContent = "rendered securely"</script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await fetchWithBrowser(`${base}/redirect`, chromiumPath, 10), null, 'default blocks local navigation');
    // 30 s, not 15: this budget includes a cold Chromium launch, and a loaded CI runner
    // once took 15.3 s and failed the assertion below as if the sandbox were broken.
    const page = await fetchWithBrowser(`${base}/redirect`, chromiumPath, 30, { allowPrivate: true });
    assert.ok(page, 'Chromium must start with its sandbox; CI must provide a functioning sandbox');
    assert.match(page.html, /<div id="result">rendered securely<\/div>/);
    assert.equal(page.url, `${base}/page`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
