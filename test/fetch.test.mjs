// Fetch order against a local server: honest UA first, browser UA only on failure,
// headless browser only when the result is still empty or a stub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULTS, deepMerge } from '../dist/config.js';
import { getArticle } from '../dist/pipeline.js';
import { fetchWithBrowser } from '../dist/browser.js';
import { FIXTURES, fixtureHtml } from './helpers.mjs';

const real = fixtureHtml('tante-friction');
const decoy = readFileSync(`${FIXTURES}tante-friction.browser-ua.html`, 'utf8');
const ploum = fixtureHtml('ploum-calendar');
const JS_PAGE = `<!doctype html><html><head><title>JS app</title></head><body><div id="app">Loading…</div>
<script>
  const p = ${JSON.stringify('This paragraph only exists after JavaScript runs. '.repeat(12))};
  document.getElementById('app').innerHTML = '<article><h1>Rendered by script</h1>' + [1,2,3].map(i => '<p>' + i + '. ' + p + '</p>').join('') + '</article>';
</script></body></html>`;

const isBrowserUA = ua => /Mozilla|Chrome/.test(ua ?? '');
let server, base;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    const ua = req.headers['user-agent'];
    seen.push([req.url, ua]);
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (req.url === '/tante') return send(200, isBrowserUA(ua) ? decoy : real);
    if (req.url === '/blocks-tools') return isBrowserUA(ua) ? send(200, ploum) : send(403, 'go away');
    if (req.url === '/js') return send(200, JS_PAGE);
    if (req.url === '/latin2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1250' });
      const body = `<html><head><title>Příliš žluťoučký kůň</title></head><body><article><h1>Příliš žluťoučký kůň</h1>${Array.from({ length: 20 }, (_, i) => `<p>${i}. Příliš žluťoučký kůň úpěl ďábelské ódy.</p>`).join('')}</article></body></html>`;
      return res.end(encode1250(body));
    }
    send(404, 'nope');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Minimal windows-1250 encoder for the Czech letters used above.
function encode1250(s) {
  const map = { 'ř': 0xf8, 'í': 0xed, 'š': 0x9a, 'ž': 0x9e, 'ť': 0x9d, 'č': 0xe8, 'ů': 0xf9, 'ú': 0xfa, 'ě': 0xec, 'ď': 0xef, 'é': 0xe9, 'ó': 0xf3, 'ý': 0xfd, 'ň': 0xf2, 'á': 0xe1 };
  return Buffer.from([...s].map(c => c.charCodeAt(0) < 128 ? c.charCodeAt(0) : map[c] ?? 0x3f));
}

const cfg = deepMerge(DEFAULTS, { allow_private: true, timeout: 10, browser: { mode: 'auto', min_words: 50 } });
const noBrowser = async () => assert.fail('headless browser must not be used here');

test('tante.cc decoy: the honest UA gets the real article and no browser UA is tried', async () => {
  seen.length = 0;
  const a = await getArticle(`${base}/tante`, cfg, { fetchBrowser: noBrowser });
  assert.equal(a.title, 'Friction and not being touched');
  assert.ok(seen.every(([, ua]) => !isBrowserUA(ua)), 'only honest requests');
});

test('a site that refuses tools gets one retry with a browser UA', async () => {
  seen.length = 0;
  const a = await getArticle(`${base}/blocks-tools`, cfg, { fetchBrowser: noBrowser });
  assert.equal(a.title, 'How I fell in love with calendar.txt');
  assert.deepEqual(seen.map(([, ua]) => isBrowserUA(ua)), [false, true]);
});

test('page charset is honoured (windows-1250)', async () => {
  const a = await getArticle(`${base}/latin2`, cfg, { fetchBrowser: noBrowser });
  assert.equal(a.title, 'Příliš žluťoučký kůň');
  assert.match(a.content, /úpěl ďábelské ódy/);
});

test('browser mode "never": a JS-only page is not sent to Chromium (the stub is returned, with a warning)', async () => {
  const a = await getArticle(`${base}/js`, cfg, { browser: 'never', fetchBrowser: noBrowser });
  assert.equal(a.content, 'Loading…');
});

test('JS-only page falls back to the headless browser (stubbed browser)', async () => {
  let called = 0;
  const fake = async url => { called++; return { html: `<html><body><article><h1>X</h1>${Array.from({ length: 20 }, (_, i) => `<p>${i}. Rendered words here and more.</p>`).join('')}</article></body></html>`, url, via: 'headless browser' }; };
  const a = await getArticle(`${base}/js`, cfg, { fetchBrowser: fake });
  assert.equal(called, 1);
  assert.ok(a.words > 50);
});

// Real Chromium, when one is available (set WCLIP_CHROMIUM, or Playwright's own browser).
const chromium = process.env.WCLIP_CHROMIUM ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium'].find(existsSync);
test('JS-only page through real headless Chromium', { skip: !chromium && 'no Chromium found' }, async () => {
  const c = deepMerge(cfg, { browser: { executable: chromium } });
  const a = await getArticle(`${base}/js`, c, { fetchBrowser: fetchWithBrowser });
  assert.match(a.content, /This paragraph only exists after JavaScript runs\./);
  assert.ok(a.words > 100);
});
