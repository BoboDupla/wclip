// Independent-review regressions: validate Markdown in a math-unaware renderer too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { parseHTML } from 'linkedom';
import { sanitizeMarkdown, safeUrl } from '../dist/sanitize.js';
import { extract } from '../dist/extract.js';
import { renderMarkdown, noteToEpub } from '../dist/render.js';

function assertInert(markdown) {
  const html = new Marked({ gfm: true }).parse(markdown);
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll('script,iframe,object,embed,svg,form').length, 0, html);
  for (const el of document.querySelectorAll('*')) for (const a of el.attributes) {
    assert.ok(!/^on/i.test(a.name), html);
    if (a.name === 'href' || a.name === 'src') assert.ok(safeUrl(a.value, a.name === 'src'), html);
  }
}

test('dollars cannot hide dangerous HTML attributes or active math contents from Markdown cleaning', () => {
  for (const input of [
    '<a href="https://example.org/$" onclick="alert(1)" data-x="$">click</a>',
    '<table title="$" onclick="alert(1)" data-x="$"><tr><td>42</td></tr></table>',
    '$<img src=x onerror=alert(1)>$', '$[x](javascript:alert(1))$',
    '$    <img src=x onerror=alert(1)>$', '$    [x](javascript:alert(1))$',
    '$$ <a href="file:///wclip-review-sentinel">click</a> $$',
    '$$<iframe srcdoc="<script>alert(1)</script>"></iframe>$$',
  ]) assertInert(sanitizeMarkdown(input));
});

test('removing disallowed tokens cannot join surrounding text into active HTML', () => {
  for (const input of [
    'before <img <iframe></iframe>src=x onerror=alert(1)> after',
    'before <scr<iframe></iframe>ipt>alert(1)</scr<iframe></iframe>ipt> after',
    'before <img <svg></svg>src=x onerror=alert(1)> after',
    '[click](java<iframe></iframe>script:alert(1))',
  ]) assertInert(sanitizeMarkdown(input));
});

test('table math bypass is closed in the complete extraction-to-Markdown path', async () => {
  const prose = '<p>Substantial research article prose about scientific software and computer programming.</p>';
  const html = `<html><head><title>Research</title></head><body><article>${prose}<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2">$$ <a href="file:///wclip-review-sentinel">click</a> $$</td></tr></table>${prose}</article></body></html>`;
  const art = await extract(html, 'https://example.org/article', { boilerplate: {}, includeImages: true });
  assertInert(art.content);
  assert.ok(art.content.includes('Substantial research article'));
});

test('dollar signs in raw HTML and Markdown URL destinations are not rendered as math', () => {
  const source = '<a href="https://example.org/$x$">raw link</a> <img src="https://example.org/$x$.png">\n\n' +
    '[inline](https://example.org/$x$) ![image](/images/$x$.png)\n\n[ref][id]\n\n[id]: https://example.org/$x$\n\n$x^2$';
  const { document } = parseHTML(`<html><body>${renderMarkdown(source)}</body></html>`);
  assert.deepEqual([...document.querySelectorAll('a')].map(a => a.getAttribute('href')), [
    'https://example.org/$x$', 'https://example.org/$x$', 'https://example.org/$x$',
  ]);
  assert.deepEqual([...document.querySelectorAll('img')].map(a => a.getAttribute('src')), ['https://example.org/$x$.png', '/images/$x$.png']);
  assert.equal(document.querySelectorAll('math').length, 1);
});

test('an invalid lead-image hostname does not abort an otherwise readable article', async () => {
  assert.equal(safeUrl('https://exa mple.org/hero.png', true), false);
  const html = '<html><head><title>Readable</title><meta property="og:image" content="https://exa mple.org/hero.png"></head><body><article><img src="https://example.org/hero.png" width="500"><p>A readable article with enough real content to extract without failing on malformed image metadata.</p></article></body></html>';
  const art = await extract(html, 'https://example.org/article', { boilerplate: {}, includeImages: true });
  assert.ok(art.content.includes('readable article'));
});

test('EPUB stops scheduling downloads after its aggregate image budget is full', async () => {
  const data = Buffer.alloc(15 * 1024 * 1024);
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let calls = 0;
  const note = Array.from({ length: 100 }, (_, i) => `![image](https://example.org/${i}.png)`).join('\n\n');
  await noteToEpub(note, 'bounded', async () => { calls++; return { type: 'image/png', data }; });
  assert.ok(calls <= 8, `made ${calls} requests after a 60 MiB budget (only in-flight work may overshoot)`);
});
