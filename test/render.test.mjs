// HTML/EPUB renditions: math to MathML, EPUB structure, images embedded, well-formed XHTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { noteToEpub, noteToHtml, renderMarkdown } from '../dist/render.js';

const note = `---
title: "A & B"
source: "https://example.org/a"
author:
  - "Jane"
published: 2025-01-01
created: 2026-10-16
---

Inline $x_1^2$ and display:

$$\\sum_{i=1}^n i$$

Money: $5 and $10 stay text. A <history_text> token. Footnote[^1].

![a pic](https://example.org/p.png)

![gone](https://example.org/missing.png)

<table><tr><td>cell <sup><a href="#fn:1">1</a></sup><br></td></tr></table>

[^1]: The note &nbsp; here.
`;

test('math becomes MathML, money and pseudo-tags stay text', () => {
  const html = renderMarkdown(note.split('---\n')[2]);
  assert.equal((html.match(/<math/g) ?? []).length, 2);
  assert.match(html, /Money: \$5 and \$10 stay text/);
  assert.match(html, /&lt;history_text&gt;/);
  assert.match(html, /href="#footnote-1"/);
  assert.doesNotMatch(html, /#fn:1/);
});

test('HTML rendition has title, byline and source footer', () => {
  const html = noteToHtml(note, 'a-b');
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /<div class="byline">Jane &middot; <a href="https:\/\/example.org\/a">source<\/a><\/div>/);
});

test('EPUB: mimetype first and stored, images embedded, failed image replaced by its alt text, XHTML well-formed', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const fetchImage = async url => url.endsWith('/p.png') ? { type: 'image/png', data: png } : null;
  const epub = await noteToEpub(note, 'a-b', fetchImage);
  // Local file header of the first entry: name "mimetype", compression method 0 (stored).
  assert.equal(strFromU8(epub.subarray(30, 38)), 'mimetype');
  assert.equal(epub[8] | (epub[9] << 8), 0);
  const files = unzipSync(epub);
  const content = strFromU8(files['OEBPS/content.xhtml']);
  const opf = strFromU8(files['OEBPS/content.opf']);
  assert.ok(files['OEBPS/images/img1.png']);
  assert.match(content, /<img src="images\/img1.png" alt="a pic"\/>/);
  assert.match(content, /\[image: gone\]/);
  assert.doesNotMatch(content, /https:\/\/example.org\/.*\.png/);
  assert.match(opf, /<item id="img1" href="images\/img1.png" media-type="image\/png"\/>/);
  assert.match(opf, /properties="mathml"/);
  const dir = mkdtempSync(join(tmpdir(), 'wclip-'));
  writeFileSync(join(dir, 'c.xhtml'), content);
  try {
    execFileSync('xmllint', ['--noout', join(dir, 'c.xhtml')], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') return; // xmllint not installed; skip the well-formedness check
    assert.fail(`content.xhtml is not well-formed XML:\n${e.stderr}`);
  }
});
