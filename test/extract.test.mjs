// Regression tests on the eight captured pages: exact golden output, plus one named check per
// known extraction issue so a failure says what broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extract } from '../dist/extract.js';
import { GOLDEN, slugs, fixtureHtml, fixtureUrl, extractOptions } from './helpers.mjs';

const results = {};
const get = async slug => (results[slug] ??= await extract(fixtureHtml(slug), fixtureUrl(slug), extractOptions));

for (const slug of slugs) {
  test(`golden: ${slug}`, async () => {
    const { content, ...meta } = await get(slug);
    assert.equal(content + '\n', readFileSync(`${GOLDEN}${slug}.md`, 'utf8'), 'markdown differs (node test/make-golden.mjs regenerates)');
    assert.deepEqual(meta, JSON.parse(readFileSync(`${GOLDEN}${slug}.json`, 'utf8')));
  });
  test(`no raw <svg>/<math>/<script> left: ${slug}`, async () => {
    const { content } = await get(slug);
    assert.doesNotMatch(content, /<(svg|math|script)\b/);
  });
}

test('ploum-calendar keeps its last paragraph (Defuddle content patterns dropped it)', async () => {
  assert.match((await get('ploum-calendar')).content, /Android is not Unix\./);
});

test('ploum: byline split into author and date, signature bio removed', async () => {
  const a = await get('ploum-ai-policy');
  assert.equal(a.author, 'Ploum');
  assert.equal(a.published, '2026-09-09');
  assert.equal(a.site, 'ploum.net');
  assert.doesNotMatch(a.content, /Bikepunk logo/); // decorative header image is not "restored"
});

test('arXiv 2507.21509: contributions list kept, 8 of 8 figure images, metadata from the API', async () => {
  const a = await get('arxiv-2507.21509');
  assert.match(a.content, /Our contributions and findings are summarized as follows[^\n]*\n\n- We develop an automated pipeline/);
  assert.equal((a.content.match(/!\[/g) ?? []).length, 8);
  assert.doesNotMatch(a.content, /Refer to caption/);
  assert.match(a.author, /^Runjin Chen, Andy Arditi, Henry Sleight, Owain Evans, Jack Lindsey$/);
  assert.equal(a.published, '2025-07-29');
  assert.equal(a.site, 'arXiv');
});

test('arXiv: pseudo-tags are escaped, prompt boxes become quotes', async () => {
  const a = await get('arxiv-2507.21509');
  assert.match(a.content, /> \\<trait\\_description>/);
});

test('arXiv: images are absolute URLs', async () => {
  for (const slug of ['arxiv-2507.21509', 'arxiv-2605.08816']) {
    for (const [, src] of (await get(slug)).content.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) assert.match(src, /^https:\/\/arxiv\.org\//);
  }
});

test('Ars: subheadings of later body sections kept', async () => {
  assert.match((await get('ars-meta-piracy')).content, /^## Evidence may prove Meta seeded more content/m);
  assert.match((await get('ars-meta-yandex')).content, /^## There’s got to be a better way/m);
});

test('Ars piracy: hero image restored on top', async () => {
  const a = await get('ars-meta-piracy');
  assert.match(a.content, /^!\[\]\(https:\/\/cdn\.arstechnica\.net\/wp-content\/uploads\/2025\/07\/GettyImages-1264284948-1152x648\.jpg\)/);
});

test('Ars: blockquotes stay blockquotes', async () => {
  assert.ok(((await get('ars-meta-yandex')).content.match(/^> /gm) ?? []).length >= 7);
});

test('tante: Patreon/CC footer removed, licence kept as metadata', async () => {
  for (const slug of ['tante-friction', 'tante-fund']) {
    const a = await get(slug);
    assert.doesNotMatch(a.content, /patreon/i);
    assert.equal(a.license, 'https://creativecommons.org/licenses/by-sa/4.0/');
  }
});

test('boilerplate selectors come from config; a bad selector is skipped, not fatal', async () => {
  const slug = 'tante-friction';
  const a = await extract(fixtureHtml(slug), fixtureUrl(slug), {
    ...extractOptions, boilerplate: { '*': ['p:has(', 'blockquote'], 'tante.cc': [] },
  });
  assert.doesNotMatch(a.content, /^> /m);
});

test('lede that repeats the meta description is kept whole, not cut to a fragment', async () => {
  // A standfirst that the page also puts in <meta name="description"> must survive: dropping it
  // deleted real prose, and slicing the Markdown by the description's plain-text length (the
  // paragraph carries ** and * the description does not) left "gy*.**" at the top of the note.
  const lede = 'Why do our grids show a brief spike in electricity demand every minute? A team has now '
    + 'demonstrated that this is due to regular power checks carried out by large-scale battery storage '
    + 'systems, as the team reports in an article published in Nature Energy.';
  const html = `<!doctype html><html><head><title>Grid</title>
<meta name="description" content="${lede}"><meta property="og:description" content="${lede}"></head>
<body><article><h1>Grid</h1>
<p><b>${lede.replace('Nature Energy', '<i>Nature Energy</i>')}</b></p>
<p>Tennet Germany, the largest transmission system operator in Germany, has observed over several years
that the frequency in the European power grid dips briefly every 60 seconds, for reasons nobody could
explain until now.</p>
<p>Third paragraph, long enough that content extraction keeps the article body and does not treat this
page as a stub of navigation links.</p>
</article></body></html>`;
  const a = await extract(html, 'https://example.org/news/grid', { boilerplate: {}, includeImages: true });
  assert.equal(a.content.split('\n')[0], `**${lede.replace('Nature Energy', '*Nature Energy*')}**`);
  assert.match(a.content, /60 seconds/);
});

test('include_images: false drops images', async () => {
  const slug = 'ars-meta-yandex';
  const a = await extract(fixtureHtml(slug), fixtureUrl(slug), { ...extractOptions, includeImages: false });
  assert.doesNotMatch(a.content, /!\[/);
});
