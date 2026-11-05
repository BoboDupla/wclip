// Regression tests on the eight captured pages: exact golden output, plus one named check per
// known extraction issue so a failure says what broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extract, separateCaptionLabels, unwrapProseCodeBlock } from '../dist/extract.js';
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

test('a caption welded onto the sentence above it gets its own paragraph', () => {
  assert.equal(
    separateCaptionLabels('The grid dips every minute.Credit: Charnchai Guoy | iStock / Getty Images Plus'),
    'The grid dips every minute.\n\nCredit: Charnchai Guoy | iStock / Getty Images Plus');
  // German labels, a byline-style caption and a closing quote after the punctuation.
  assert.equal(separateCaptionLabels('Die Frequenz sinkt jede Minute.Foto: Forschungszentrum Jülich'),
    'Die Frequenz sinkt jede Minute.\n\nFoto: Forschungszentrum Jülich');
  assert.equal(separateCaptionLabels('It dips every minute.Photo by Regine Panknin'),
    'It dips every minute.\n\nPhoto by Regine Panknin');
  assert.equal(separateCaptionLabels('“It dips every minute.”Quelle: Tennet'),
    '“It dips every minute.”\n\nQuelle: Tennet');
});

test('prose that merely mentions a caption label is not split', () => {
  for (const md of [
    'He paid by card. Credit: the invoice was never sent.', // spaced label is ordinary prose
    'The credit: line was empty.',
    'See fig. 3 for the comparison.',
    'Version 1.2.Photo graphs are elsewhere.', // "Photo graphs" is not a caption label
  ]) assert.equal(separateCaptionLabels(md), md);
});

test('include_images: false drops images', async () => {
  const slug = 'ars-meta-yandex';
  const a = await extract(fixtureHtml(slug), fixtureUrl(slug), { ...extractOptions, includeImages: false });
  assert.doesNotMatch(a.content, /!\[/);
});

test('a post that is one unlabelled <pre> of prose is unwrapped into paragraphs', async () => {
  const { content } = await get('alxgsv-let-me-check');
  assert.doesNotMatch(content, /^```/m);
  assert.match(content, /^That morning I woke up at 6:58, two minutes before the alarm\./);
  assert.match(content, /\n\nFor now\.$/);
});

const FENCE = '```';
test('a fenced block stays fenced unless it is prose and the whole article', () => {
  const prose = 'The left one in my toaster always burns; my toaster has a favorite side. ' +
    'And that was the only thing I was sure of that morning. I always iron a shirt.';
  const block = (lang, body) => FENCE + lang + '\n' + body + '\n' + FENCE;
  const body = prose + '\n\n' + prose;
  assert.equal(unwrapProseCodeBlock(block('', body)), body);
  // a language tag, a code shape, or other text around the block all mean "leave it alone"
  assert.equal(unwrapProseCodeBlock(block('js', body)), null);
  assert.equal(unwrapProseCodeBlock(block('', 'const x = 1;\n\nconsole.log(x);')), null);
  assert.equal(unwrapProseCodeBlock('Intro.\n\n' + block('', body)), null);
  assert.equal(unwrapProseCodeBlock(block('', prose)), null); // one paragraph is no article
});
