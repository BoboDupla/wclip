// Paywall behaviour: status hints, cookie-authenticated fetch, cross-host cookie scoping
// and the teaser warning. Fixtures are built in-process; nothing here touches the internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULTS, deepMerge } from '../dist/config.js';
import { cookieJar, parseCookieFile } from '../dist/cookies.js';
import { getArticle } from '../dist/pipeline.js';
import { statusHint } from '../dist/fetch.js';
import { teaserReason } from '../dist/teaser.js';

const WORDS = 'This paragraph carries real reporting and enough words to look like an article body. ';
const article = (paras, heading = 'A real story') =>
  `<!doctype html><html><head><title>${heading}</title></head><body><article><h1>${heading}</h1>` +
  paras.map(p => `<p>${p}</p>`).join('') + '</article></body></html>';

const TEASER = article([
  'During a ride in a Southern California desert, an executive stopped his dirt bike and shot his old iPod.',
  'He sold flash storage to Apple and hated feeling like he always got the worst end of the deal.',
  'The disparity in bargaining power had galled him, who used Android phones in protest.',
  'He kept the broken pieces. They sit on his desk and hold a special reverence now that the tables have turned.',
  'Copyright ©2026 Dow Jones &amp; Company, Inc. All Rights Reserved. 87990cbe856818d5eddac44c7b1cdeb8',
]);

const LONG = article(Array.from({ length: 30 }, (_, i) => `${WORDS}Section ${i} keeps the wording distinct so nothing is deduplicated as boilerplate.`));

let server, base, other, otherBase;
const seen = [];

before(async () => {
  other = createServer((req, res) => {
    seen.push(['other', req.headers.cookie ?? null]);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LONG);
  });
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  otherBase = `http://localhost:${other.address().port}`;

  server = createServer((req, res) => {
    seen.push([req.url, req.headers.cookie ?? null]);
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (req.url === '/paywalled') {
      // The WSJ shape: 401 for anonymous clients, full text for a session cookie.
      return req.headers.cookie === 'sessionid=SECRET1' ? send(200, LONG) : send(401, 'unauthorized');
    }
    if (req.url === '/teaser') return send(200, TEASER);
    if (req.url === '/away') {
      res.writeHead(302, { location: `${otherBase}/story` });
      return res.end();
    }
    send(404, 'nope');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); other.close(); });

const cfg = deepMerge(DEFAULTS, { allow_private: true, timeout: 10, browser: { mode: 'never' } });
const noBrowser = async () => null;
const cookie = text => cookieJar(parseCookieFile(text));

test('status hints name the wall instead of leaving a bare code', () => {
  assert.match(statusHint(401), /login or subscription/);
  assert.match(statusHint(403), /bot wall|blocked/);
  assert.match(statusHint(429), /rate limited/);
  assert.equal(statusHint(404), null);
  assert.equal(statusHint(200), null);
});

test('an anonymous 401 fails with an actionable message, not "could not fetch" alone', async () => {
  const err = await getArticle(`${base}/paywalled`, cfg, { fetchBrowser: noBrowser }).catch(e => e);
  assert.match(err.message, /could not fetch/);
  assert.match(err.message, /login or subscription required/);
  assert.match(err.message, /--cookies FILE/);
  assert.match(err.message, /--html saved\.html/);
});

test('a matching session cookie turns the same 401 into a full article', async () => {
  seen.length = 0;
  const a = await getArticle(`${base}/paywalled`, cfg, {
    fetchBrowser: noBrowser, cookies: cookie('127.0.0.1\tFALSE\t/\tFALSE\t0\tsessionid\tSECRET1'),
  });
  assert.equal(a.words > 200, true);
  assert.deepEqual(seen.map(([, c]) => c), ['sessionid=SECRET1']);
});

test('a cookie for another host is never sent', async () => {
  seen.length = 0;
  await getArticle(`${base}/paywalled`, cfg, {
    fetchBrowser: noBrowser, cookies: cookie('example.com\tFALSE\t/\tFALSE\t0\tsessionid\tSECRET1'),
  }).catch(() => {});
  assert.deepEqual(seen.map(([, c]) => c), [null, null], 'both attempts went out unauthenticated');
});

test('a cross-host redirect does not carry the cookie along', async () => {
  seen.length = 0;
  const a = await getArticle(`${base}/away`, cfg, {
    fetchBrowser: noBrowser, cookies: cookie('127.0.0.1\tFALSE\t/\tFALSE\t0\tsessionid\tSECRET1'),
  });
  assert.ok(a.words > 200);
  const redirected = seen.find(([where]) => where === 'other');
  assert.equal(redirected[1], null, 'the second host must not receive the first host\'s cookie');
});

test('a paywalled teaser is warned about, while still being clipped', async () => {
  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  try {
    const a = await getArticle(`${base}/teaser`, cfg, { fetchBrowser: noBrowser });
    assert.match(a.content, /special reverence/);
  } finally {
    process.stderr.write = original;
  }
  const log = written.join('');
  assert.match(log, /incomplete article/);
  assert.match(log, /copyright notice/);
  assert.match(log, /--cookies FILE/);
});

test('a saved teaser page (--html) is flagged too, not just a live fetch', async () => {
  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  try {
    await getArticle('https://www.wsj.com/tech/example', cfg, { html: TEASER, fetchBrowser: noBrowser });
  } finally {
    process.stderr.write = original;
  }
  assert.match(written.join(''), /incomplete article: the body ends with a copyright notice/);
});

test('teaser detection ignores long articles and short posts without markers', () => {
  const long = `${WORDS.repeat(400)}\n\nCopyright ©2026 Dow Jones &amp; Company, Inc. All Rights Reserved.`;
  assert.equal(teaserReason(long, 4000), null, 'length alone rules it out');
  assert.equal(teaserReason('A short note about nothing in particular.', 7), null);
  assert.match(teaserReason('Some lede text that was cut off here.\n\n© 2026 Dow Jones & Company', 9), /copyright/);
  assert.match(teaserReason('Only the lede.\n\nTo continue reading, subscribe now.', 4), /subscribe|login/);
  assert.equal(teaserReason('', 0), null);
});
