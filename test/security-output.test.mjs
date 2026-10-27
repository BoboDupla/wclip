import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseHTML } from 'linkedom';
import { unzipSync, strFromU8 } from 'fflate';
import { extract } from '../dist/extract.js';
import { htmlToXhtml, makeImageFetcher, noteToEpub, noteToHtml, renderMarkdown } from '../dist/render.js';
import { MAX_IMAGE_BYTES, markdownImage, safeUrl, sanitizeBody, sanitizeMarkdown } from '../dist/sanitize.js';

const opts = { boilerplate: {}, includeImages: true };
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const escape = s => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const prose = Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}: This is substantial article prose about scientific research, mathematics, software and careful preservation of the complete original text.</p>`).join('');
const page = (content, head = '', before = '') => `<!doctype html><html><head><title>Safety article</title>${head}</head><body>${before}<article><h1>Safety article</h1>${prose}${content}${prose}</article></body></html>`;
const note = (body, source = 'https://example.org/article') => `---\ntitle: Safety article\nsource: ${JSON.stringify(source)}\nauthor: [Alice, Bob]\ncreated: 2026-10-27\n---\n\n${body}`;
const epubFiles = async (body, fetcher = null, source) => unzipSync(await noteToEpub(note(body, source), 'safety', fetcher));
function assertPassive(html) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll('script,iframe,object,embed,form,input,svg,foreignObject,base,link').length, 0);
  for (const el of document.querySelectorAll('*')) for (const attr of el.attributes) {
    assert.doesNotMatch(attr.name, /^on/i);
    if (['href', 'src', 'xlink:href'].includes(attr.name)) assert.ok(safeUrl(attr.value, attr.name === 'src'), `${attr.name}=${attr.value}`);
  }
}

test('final HTML, XHTML and EPUB strip active markup, event attrs, style and disguised schemes', async () => {
  const body = `<div style="background:url(javascript:evil())" onclick="evil()">kept text</div>
<a href="&#106;avascript:alert(1)" onfocus="evil()">numeric</a>
<a href="java&#x09;script:alert(1)">tab</a>
<a href="data:text/html,evil">data link</a>
<img src="javascript:evil()" onerror="evil()">
<iframe srcdoc="<script>evil()</script>">fallback</iframe><form action="https://evil.org"><input autofocus onfocus="evil()"></form>
<svg onload="evil()"><foreignObject><img src=x onerror="evil()"></foreignObject></svg>
<script>evil()</script>

[markdown](javascript:alert(1))

[entity](java&#x73;cript:alert(1))

[safe](https://example.org/path?q=1&x=2)`;
  const html = renderMarkdown(body);
  assertPassive(html);
  assert.match(html, /kept text/);
  assert.doesNotMatch(html, /style=|onclick=|onerror=|onfocus=/i);
  assert.match(html, /href="https:\/\/example.org\/path\?q=1&amp;x=2"/);
  assertPassive(htmlToXhtml(body));
  const content = strFromU8((await epubFiles(body))['OEBPS/content.xhtml']);
  assertPassive(content);
  assert.doesNotMatch(content, /\sscripted\b|style="/);
});

test('standalone HTML has restrictive CSP/referrer and validates source metadata hrefs', async () => {
  for (const source of ['javascript:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)', 'data:text/html,evil']) {
    const html = noteToHtml(note('Body', source), 'safety');
    const { document } = parseHTML(html);
    assert.equal(document.querySelectorAll('a[href]').length, 0);
    assert.equal(document.querySelector('meta[name=referrer]').getAttribute('content'), 'no-referrer');
    const csp = document.querySelector('meta[http-equiv=Content-Security-Policy]').getAttribute('content');
    for (const directive of ["default-src 'none'", "script-src 'none'", 'img-src https: data:', "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive));
    assertPassive(strFromU8((await epubFiles('Body', null, source))['OEBPS/content.xhtml']));
  }
});

test('safe Markdown neutralizes raw HTML and inline/reference javascript links without rewriting math/code', () => {
  const source = `A $x_1^2$ equation and $$\\sum_{i=1}^n i$$.

| A | B |
|---|---|
| $a_b$ | [evil](javascript:alert(1)) |

[good](https://example.org/a_(b))[^1]

[^1]: footnote with [bad][id]

[id]: java&#x73;cript:alert(1)

> [bad](javascript:evil())
>
> <a onmouseover="evil()" href="javascript:evil()">quoted</a>

<figure onclick="evil()"><img src="https://example.org/p.png" onerror="evil()"><figcaption>Caption</figcaption></figure>

~~~js
const sample = '<img onerror="example()">';
const link = '[code](javascript:example())';
const tex = '$x_y$';
~~~

\`\`literal \` $x_y$ <img onerror="example()">\`\`
`;
  const clean = sanitizeMarkdown(source);
  assert.match(clean, /\$x_1\^2\$/);
  assert.match(clean, /\$\$\\sum_\{i=1\}\^n i\$\$/);
  assert.match(clean, /\| \$a_b\$ \| evil \|/);
  assert.match(clean, /\[good\]\(https:\/\/example.org\/a_\(b\)\)\[\^1\]/);
  assert.match(clean, /\[\^1\]: footnote with bad/);
  assert.match(clean, /<figure><img src="https:\/\/example.org\/p.png" \/><figcaption>Caption<\/figcaption><\/figure>/);
  const code = source.slice(source.indexOf('~~~js'));
  assert.ok(clean.endsWith(code));
  assert.doesNotMatch(clean.slice(0, clean.indexOf('~~~js')), /javascript:|onerror=|onmouseover=|onclick=/i);
  assertPassive(renderMarkdown(clean));
});

test('og:image query breakout and hostile alt text cannot create a new Markdown/raw HTML element', async () => {
  const image = 'https://example.org/hero.png?q=)<img src=x onerror=alert(1)>';
  const alt = 'caption ](javascript:evil()) <img src=x onerror=evil()> \\';
  const article = await extract(page('<p>Final paragraph.</p>', `<meta property="og:image" content="${escape(image)}">`, `<header><img width="800" src="https://example.org/hero.png" alt="${escape(alt)}"></header>`), 'https://example.org/article', opts);
  assert.match(article.content, /^!\[/);
  assert.ok(article.content.includes('%29%3Cimg%20src=x%20onerror=alert%281%29%3E'));
  assert.doesNotMatch(article.content, /<img src=x|\]\(javascript:/);
  const { document } = parseHTML(`<html><body>${renderMarkdown(article.content)}</body></html>`);
  assert.equal(document.querySelectorAll('img').length, 1);
  assertPassive(document.body.innerHTML);
  assert.ok(safeUrl(image, true));
  assert.match(markdownImage('[]\\<>', image), /%29%3Cimg/);
});

test('MathML TeX annotation containing $<img onerror> is text, not decoded injection', async () => {
  const tex = '$<img src=x onerror=alert(1)> + x_1^2';
  const raw = `<table><tr><th>Formula</th><th>Value</th></tr><tr><td><math><semantics><mi>x</mi><annotation encoding="application/x-tex">${escape(tex)}</annotation></semantics></math></td><td>42</td></tr></table><p>Legitimate formula <math><semantics><msub><mi>x</mi><mn>1</mn></msub><annotation encoding="application/x-tex">x_1^2</annotation></semantics></math> remains.</p>`;
  const article = await extract(page(raw), 'https://example.org/math', opts);
  assert.doesNotMatch(article.content, /<img\b|<math\b|<annotation\b/);
  assert.match(article.content, /x_1\^2/);
  assert.match(article.content, /42/);
  const html = renderMarkdown(article.content);
  assertPassive(html);
  assert.match(html, /<math/);
  assert.equal(parseHTML(`<html><body>${html}</body></html>`).document.querySelectorAll('img').length, 0);
});

test('extracted Markdown removes active table attributes and javascript links before note writing', async () => {
  const raw = `<table onclick="evil()" style="background:red"><tr><th>Link</th><th>Figure</th></tr><tr><td><a href="java&#x73;cript:alert(1)" onmouseover="evil()">Unsafe destination</a></td><td><img src="https://example.org/figure.png" onerror="evil()" alt="figure"></td></tr></table><p><a href="javascript:alert(1)">Inline destination</a> and <a href="https://example.org/safe">safe destination</a>.</p>`;
  const article = await extract(page(raw), 'https://example.org/article', opts);
  assert.doesNotMatch(article.content, /javascript:|onerror=|onmouseover=|onclick=|style=/i);
  assert.match(article.content, /Unsafe destination/);
  assert.match(article.content, /Inline destination/);
  assert.match(article.content, /https:\/\/example.org\/safe/);
  assertPassive(renderMarkdown(article.content));
});

test('literal math placeholder text never crashes or aliases generated math; all code syntaxes stay code', () => {
  const md = `WCMATHPH999Z WCMATHPH0Z $x_1^2$

~~~js
'$not_math$'
~~~

\`\` literal \` $not_math$ \`\`

\`\`\`\`text
\`\`\`
$not_math$
\`\`\`\`

\`\`\`unclosed
$not_math$`;
  const html = renderMarkdown(md);
  assert.equal((html.match(/<math\b/g) ?? []).length, 1);
  assert.match(html, /WCMATHPH999Z WCMATHPH0Z/);
  assert.equal((html.match(/\$not_math\$/g) ?? []).length, 4);
});

test('nested tilde fences and indented code cannot turn protected math into MathML', () => {
  const source = '> ~~~js\n> const value = "$not_math$";\n> ~~~\n\n    $also_not_math$ <img onerror="example()">\n\nA real $x_1^2$ equation.';
  const html = renderMarkdown(source);
  assert.equal((html.match(/<math\b/g) ?? []).length, 1);
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll('pre code').length, 2);
  for (const code of document.querySelectorAll('pre code')) {
    assert.equal(code.querySelectorAll('math,img').length, 0);
    assert.match(code.textContent, /\$(?:also_)?not_math\$/);
  }
  assert.equal(sanitizeMarkdown(source), source);
});

test('data URLs allow only size-bounded signature-checked raster images, never SVG/HTML', () => {
  const valid = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  for (const src of ['data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImV2aWwoKSIvPg==', 'data:text/html;base64,PHNjcmlwdD5ldmlsKCk8L3NjcmlwdD4=', 'data:image/png;base64,PHN2ZyBvbmxvYWQ9ImV2aWwoKSIvPg==']) {
    assert.equal(safeUrl(src, true), false);
    assert.doesNotMatch(sanitizeBody(`<img src="${src}">`), /src=/);
  }
  assert.equal(safeUrl(valid, true), true);
  assert.equal(safeUrl(valid), false);
  assert.match(sanitizeBody(`<img src="${valid}" onerror="evil()">`), /src="data:image\/png;base64,/);
});

test('EPUB excludes malicious SVG even from an injected fetcher and continues after rejected requests', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>evil()</script><foreignObject><iframe src="https://evil.org"/></foreignObject></svg>');
  const files = await epubFiles('![vector](https://example.org/evil.svg)\n\n![reject](https://example.org/reject.png)\n\n![good](https://example.org/good.png)', async u => {
    if (u.endsWith('.svg')) return { type: 'image/svg+xml', data: svg };
    if (u.includes('reject')) throw new Error('network failure');
    return { type: 'image/png', data: png };
  });
  assert.equal(Object.keys(files).filter(p => p.endsWith('.svg')).length, 0);
  const content = strFromU8(files['OEBPS/content.xhtml']);
  assert.match(content, /\[image: vector\]/);
  assert.match(content, /\[image: reject\]/);
  assert.match(content, /src="images\/img3.png"/);
  assertPassive(content);
});

test('EPUB caps unique requests at 128 and progress counts unique downloads, including failures', async () => {
  const body = Array.from({ length: 140 }, (_, i) => `![${i}](https://example.org/${i}.png)`).join('\n\n') + '\n\n![duplicate](https://example.org/0.png)';
  const calls = [], progress = [], completions = [];
  const book = await noteToEpub(note(body), 'caps', async u => { calls.push(u); return u.endsWith('/1.png') ? null : { type: 'image/png', data: png }; }, () => ({ progress: (a, b) => progress.push([a, b]), done: s => completions.push(s) }));
  assert.equal(calls.length, 128);
  assert.equal(new Set(calls).size, 128);
  assert.deepEqual(progress[0], [0, 128]);
  assert.deepEqual(progress.at(-1), [128, 128]);
  assert.equal(progress.length, 129);
  assert.equal(completions.length, 1);
  const files = unzipSync(book);
  assert.equal(Object.keys(files).filter(p => p.startsWith('OEBPS/images/')).length, 127);
});

test('EPUB aggregate image payload never exceeds 60 MiB; individual images are bounded to 15 MiB', async () => {
  const data = new Uint8Array(13 * 1024 * 1024); data.set(png);
  const tooLarge = new Uint8Array(MAX_IMAGE_BYTES + 1); tooLarge.set(png);
  const body = Array.from({ length: 6 }, (_, i) => `![${i}](https://example.org/${i}.png)`).join('\n\n');
  const files = await epubFiles(body, async u => ({ type: 'image/png', data: u.endsWith('/5.png') ? tooLarge : data }));
  const images = Object.entries(files).filter(([p]) => p.startsWith('OEBPS/images/'));
  assert.equal(images.length, 4);
  assert.ok(images.reduce((n, [, b]) => n + b.length, 0) <= 60 * 1024 * 1024);
});

test('makeImageFetcher uses guarded networking and bounded raster sniffing (SVG and header-only disguises omitted)', async t => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/oversize') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': MAX_IMAGE_BYTES + 1 }); res.end(); return; }
    if (req.url === '/svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg onload="evil()"/>'); return; }
    if (req.url === '/fake') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<svg onload="evil()"/>'); return; }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(png);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await makeImageFetcher('test', 1)(`${root}/good`), null);
  assert.equal(hits, 0);
  const fetcher = makeImageFetcher('test', 1, true);
  const fetched = await fetcher(`${root}/good`);
  assert.equal(fetched?.type, 'image/png');
  assert.deepEqual([...fetched.data], [...png]);
  for (const p of ['/svg', '/fake', '/oversize']) assert.equal(await fetcher(root + p), null);
});

test('extraction rejects >20 MiB before parsing, measuring UTF-8 bytes too', async () => {
  await assert.rejects(extract('x'.repeat(20 * 1024 * 1024 + 1), 'https://example.org', opts), /20 MiB/);
  await assert.rejects(extract('界'.repeat(8 * 1024 * 1024), 'https://example.org', opts), /20 MiB/);
});

test('actual terminal controls are stripped from saved Markdown, printable escape examples remain code', async () => {
  const source = 'prefix\x1b]52;c;ZXZpbA==\x07suffix\x9b31m\x00\n\n```js\n"\\x1b[31m"\n```\n';
  const clean = sanitizeMarkdown(source);
  assert.doesNotMatch(clean, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
  assert.match(clean, /"\\x1b\[31m"/);
  const article = await extract(page(`<p>prefix\x1b]52;c;ZXZpbA==\x07suffix\x9b31m</p><pre><code>"\\x1b[31m"</code></pre>`), 'https://example.org/article', opts);
  assert.doesNotMatch(article.content, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
  assert.match(article.content, /\\x1b\[31m/);
});

test('adversarial byline whitespace and unmatched MathML complete in a bounded child process', () => {
  // A subprocess timeout actually interrupts a synchronous regex regression; a
  // node:test timer cannot interrupt code that has blocked its own event loop.
  const script = `import { extract } from './dist/extract.js';
    const author = 'Author' + ' '.repeat(100000) + 'not a date';
    const text = '<p>Research article content with enough substantive information for extraction.</p>'.repeat(10);
    const html = '<html><head><title>Regex</title><meta name="author" content="' + author + '"></head><body><article><h1>Regex</h1>' + text + '<table><tr><td>' + '<math>'.repeat(3000) + 'x</td></tr></table>' + text + '</article></body></html>';
    const a = await extract(html, 'https://example.org/article', { boilerplate: {}, includeImages: false });
    if (!a.content.includes('Research article')) throw new Error('article was lost');
    console.log('completed');`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.match(result, /completed/);
});
