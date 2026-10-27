// Regressions for the two independent 0.5.0 reviews (2026-10-27) that were fixed on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { DEFAULTS } from '../dist/config.js';
import { extract } from '../dist/extract.js';
import { checkedUrl } from '../dist/network-policy.js';
import { noteToEpub, noteToHtml } from '../dist/render.js';
import { sanitizeMarkdown } from '../dist/sanitize.js';
import { normalizeUrl, wordCount } from '../dist/util.js';

const opts = { boilerplate: DEFAULTS.boilerplate, includeImages: true };
const article = (head, body) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const prose = (n, text = 'Ordinary sentence about the subject matter here. ') => text.repeat(n);

test('wordCount is linear on hostile bracket input and still counts ordinary text', () => {
  assert.equal(wordCount("Hello world it's well-known, 3.5 and [link](http://x/y) ![](http://i) Čapek"), 9);
  // Escaped parentheses inside a destination must stay part of the link.
  assert.equal(wordCount('[player character](https://en.wikipedia.org/wiki/NPC_\\(meme_\\)) x'), 3);
  const started = performance.now();
  wordCount('['.repeat(200000));
  wordCount('[]('.repeat(100000));
  wordCount('[]('.concat('x'.repeat(100000), ')'));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `wordCount took ${elapsed.toFixed(0)} ms on bracket floods (was quadratic)`);
});

test('normalizeUrl keeps a declared scheme and leaves host:port alone', () => {
  assert.equal(normalizeUrl('example.com/post'), 'https://example.com/post');
  assert.equal(normalizeUrl('HTTP://example.com/Post'), 'HTTP://example.com/Post');
  assert.equal(normalizeUrl('example.com:8080/x'), 'https://example.com:8080/x');
  assert.equal(normalizeUrl('file:///etc/passwd'), 'file:///etc/passwd');
  // The scheme now reaches the policy, which rejects it with a clear message.
  assert.throws(() => checkedUrl(normalizeUrl('file:///etc/passwd')), /unsupported URL scheme/);
  assert.equal(checkedUrl(normalizeUrl('HTTP://example.com/Post')).hostname, 'example.com');
});

test('metadata cannot smuggle control or bidi characters into a note', async () => {
  const html = article(
    '<title>Safe\u202Etxt.exe</title><meta name="author" content="Bob\u202E evil\x01">' +
    '<meta property="og:description" content="desc\u009b31m\u202dred">',
    `<article><p>${prose(40)}Body\u202Ereordered${prose(5)}</p></article>`,
  );
  const a = await extract(html, 'https://example.com/c', opts);
  for (const field of [a.title, a.author, a.description, a.site]) {
    assert.doesNotMatch(field, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/, JSON.stringify(field));
  }
  assert.doesNotMatch(a.content, /[\u202a-\u202e\u2066-\u2069]/);
  // Right-to-left marks are content, not an attack: the sanitiser must not strip them.
  assert.equal(sanitizeMarkdown('a\u200fb'), 'a\u200fb');
});

test('EPUB XHTML never contains characters XML 1.0 forbids', async () => {
  const note = `---\ntitle: "Bad\x01title\x1fhere"\nsource: "https://example.com/a"\nauthor:\n  - "Bob\x02"\ncreated: 2026-10-27\ndescription: "d\x07"\ntags: []\nread: false\nreading time: "1 min"\n---\n\nBody paragraph.\n`;
  const files = unzipSync(await noteToEpub(note, 'stem', null));
  const xhtml = strFromU8(files['OEBPS/content.xhtml']);
  assert.doesNotMatch(xhtml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  assert.match(xhtml, /<title>Badtitlehere<\/title>/);
  assert.doesNotMatch(noteToHtml(note, 'stem'), /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
});

test('a prose mention of the image filename does not suppress the lead image', async () => {
  const html = article(
    '<title>Story</title><meta property="og:image" content="https://example.com/img/xk9hero.jpg">',
    `<header><img src="/img/xk9hero.jpg" width="1200" alt="hero"></header>
     <article><h1>Story heading</h1><p>${prose(30, 'The xk9hero file is discussed in prose. ')}</p></article>`,
  );
  const a = await extract(html, 'https://example.com/s', opts);
  assert.match(a.content, /^!\[hero\]\(https:\/\/example\.com\/img\/xk9hero\.jpg\)/);
  // A one-character stem matches half a page, so it is no longer used as a signal.
  const short = article(
    '<title>S</title><meta property="og:image" content="https://example.com/a.jpg">',
    `<article><p>${prose(30)}</p><img src="/img/a.jpg" width="800" alt="x"></article>`,
  );
  assert.doesNotMatch((await extract(short, 'https://example.com/t', opts)).content, /^!\[/);
});

test('rel=license is resolved against the page and must be HTTP(S)', async () => {
  const rel = await extract(article('<title>t</title><link rel="license" href="/lic/by/4.0/">',
    `<article><p>${prose(30)}</p></article>`), 'https://example.com/x/y', opts);
  assert.equal(rel.license, 'https://example.com/lic/by/4.0/');
  const bad = await extract(article('<title>t</title><link rel="license" href="javascript:alert(1)">',
    `<article><p>${prose(30)}</p></article>`), 'https://example.com/x/y', opts);
  assert.equal(bad.license, '');
});

test('an offline (--html) extraction never calls the arXiv API', async () => {
  let called = 0;
  const html = article('<title>Paper</title>', `<article><p>${prose(30)}</p></article>`);
  const a = await extract(html, 'https://arxiv.org/html/2507.21509v3', {
    ...opts, offline: true, arxivLookup: async () => { called++; return null; },
  });
  assert.equal(called, 0);
  await extract(html, 'https://arxiv.org/html/2507.21509v3', {
    ...opts, arxivLookup: async () => { called++; return null; },
  });
  assert.equal(called, 1);
});

test('executable note-app fence languages and $= spans are defanged', () => {
  const md = ['~~~dataviewjs', 'dv.list(dv.pages())', '~~~', '', '```js', 'const x = 1;', '```',
    '', 'Inline `$= dv.current().file.name` query.'].join('\n');
  const out = sanitizeMarkdown(md);
  assert.match(out, /^~~~text$/m);
  assert.match(out, /^```js$/m, 'ordinary code fences stay intact');
  assert.doesNotMatch(out, /`\$=/);
  assert.match(out, /`\u200b\$= dv\.current/);
  // Rewriting is idempotent, so repeated passes cannot stack zero-width spaces.
  assert.equal(sanitizeMarkdown(out), out);
  // Inline DQL (`= expr`) is read-only and a legitimate code example must not be rewritten.
  assert.equal(sanitizeMarkdown('A sheet example `=SUM(A1:A3)`.'), 'A sheet example `=SUM(A1:A3)`.');
});
