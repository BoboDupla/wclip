// Defuddle plus the remediations from VERDICT.md -> out/<slug>.fixed.{md,json}.
// Prototype of the rebuild's extraction layer; every fix is a separate, named step.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';

// Fix 1: known boilerplate, removed by selector instead of Defuddle's content-pattern guessing.
const BOILERPLATE = {
  '*': ['[class^="cb_p6"]', '.cc-block', 'img[width="1"][height="1"]'],
  'ploum.net': ['div.signature'],
  'arstechnica.com': ['.upper-deck', '.pswp-caption-content'],
};

function preprocess(document, host) {
  // License: keep it as metadata before the visible block goes.
  const lic = document.querySelector('a[rel="license"], link[rel="license"]')?.getAttribute('href') ?? null;
  for (const sel of [...BOILERPLATE['*'], ...(BOILERPLATE[host] ?? [])])
    document.querySelectorAll(sel).forEach(el => el.remove());
  // arXiv's placeholder alt text; Defuddle would turn it into a caption.
  document.querySelectorAll('img[alt="Refer to caption"]').forEach(img => img.setAttribute('alt', ''));
  // Fix 2: Defuddle keeps only the first <img> of a <figure>; split multi-image figures.
  for (const fig of [...document.querySelectorAll('figure')]) {
    const imgs = [...fig.querySelectorAll('img')];
    if (imgs.length < 2) continue;
    const cap = fig.querySelector('figcaption');
    // One figure per panel, caption on the last. (Bare <p><img> panels get dropped by Defuddle.)
    const parts = imgs.map((img, i) => {
      const f = document.createElement('figure');
      f.appendChild(img.cloneNode(true));
      if (cap && i === imgs.length - 1) f.appendChild(cap.cloneNode(true));
      return f;
    });
    fig.replaceWith(...parts);
  }
  // Fix 5: text boxes drawn as SVG (arXiv/LaTeXML tcolorbox) -> blockquote of their foreignObject HTML;
  // otherwise the whole <svg> lands in the Markdown as raw markup.
  for (const svg of [...document.querySelectorAll('svg')]) {
    const fos = [...svg.querySelectorAll('foreignObject, foreignobject')];
    if (!fos.length) continue;
    const bq = document.createElement('blockquote');
    fos.forEach((fo, i) => {
      const box = document.createElement(i === 0 && fos.length > 1 ? 'p' : 'div');
      if (i === 0 && fos.length > 1) { const b = document.createElement('strong'); b.textContent = fo.textContent.trim(); box.appendChild(b); }
      else while (fo.firstChild) box.appendChild(fo.firstChild);
      bq.appendChild(box);
    });
    svg.replaceWith(bq);
  }
  return { license: lic };
}

const norm = s => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function postprocess(md, meta) {
  // Fix 3: raw MathML left inside HTML tables -> inline LaTeX from its TeX annotation.
  md = md.replace(/<math\b[\s\S]*?<annotation[^>]*>([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/g, (_, tex) => `$${decode(tex).trim()}$`);
  // Defuddle escapes "<trait>" but not "<trait\_description>"; unescaped, it reads as an HTML tag and vanishes.
  md = md.replace(/(^|[^\\])<(\/?[a-z][a-z0-9]*(?:\\_[a-z0-9]+)+)>/gm, '$1\\<$2>');
  // With content patterns off, Defuddle no longer drops a lede that repeats the description.
  // It also leaves an identical paragraph twice in a row (Ars image credits).
  let paras = md.split(/\n\s*\n/).filter((p, i, a) => i === 0 || norm(p) !== norm(a[i - 1]));
  const i = paras.findIndex(p => norm(p).length > 0);
  const d = norm(meta.description);
  if (i >= 0 && d && norm(paras[i]).startsWith(d)) {
    const rest = paras[i].slice(meta.description.length).trim();
    if (norm(paras[i]) === d || norm(rest) === norm(paras[i]).slice(d.length).trim()) paras[i] = rest;
    if (!paras[i]) paras.splice(i, 1);
  }
  return paras.join('\n\n');
}

// Fix 4: metadata. Byline-style author ("Ploum on 2025-09-03"), date from the byline or URL,
// site from og:site_name or the host, arXiv from its API (the HTML rendition has no author/date meta).
async function fixMeta(r, url, document) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const m = { title: r.title, author: r.author, published: r.published, site: r.site, description: r.description };
  const byline = /^(.*?)\s+on\s+(\d{4}-\d{2}-\d{2})$/.exec(m.author ?? '');
  if (byline) { m.author = byline[1]; m.published ||= byline[2]; }
  if (!m.site || m.site === r.author)
    m.site = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? host;
  m.published ||= /(\d{4})[-/](\d{2})[-/](\d{2})/.exec(new URL(url).pathname)?.slice(1).join('-');
  const arxiv = host === 'arxiv.org' && /\/(?:html|abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/.exec(url);
  if (arxiv) {
    const atom = await (await fetch(`https://export.arxiv.org/api/query?id_list=${arxiv[1]}${arxiv[2] ?? ''}`,
      { headers: { 'User-Agent': 'webclip-bakeoff/0.1 (+article clipper)' } })).text();
    const entry = atom.split('<entry>')[1] ?? '';
    const tag = t => decode(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(entry)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    m.title = tag('title') || m.title;
    m.author = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map(x => x[1].trim()).join(', ') || m.author;
    m.published = tag('published').slice(0, 10) || m.published;
    m.description = tag('summary') || m.description;
    m.site = 'arXiv';
  }
  return m;
}

const only = process.argv.slice(2);
for (const f of readdirSync('fixtures').filter(f => f.endsWith('.html')).sort()) {
  const slug = f.slice(0, -5);
  if (only.length && !only.includes(slug)) continue;
  const url = readFileSync(`fixtures/${slug}.url`, 'utf8').trim();
  const { document } = parseHTML(readFileSync(`fixtures/${f}`, 'utf8'));
  const extra = preprocess(document, new URL(url).hostname.replace(/^www\./, ''));
  // Fix 1 (cont.): content-pattern removal off; it silently dropped real paragraphs.
  const r = await Defuddle(document, url, { markdown: true, useAsync: false, removeContentPatterns: false });
  const meta = { ...(await fixMeta(r, url, document)), ...extra };
  const md = postprocess(r.content ?? '', meta);
  writeFileSync(`out/${slug}.fixed.md`, md);
  writeFileSync(`out/${slug}.fixed.json`, JSON.stringify({ ...meta, wordCount: md.split(/\s+/).filter(Boolean).length }, null, 2));
  console.log(`fixed ${slug}: ${JSON.stringify(meta).slice(0, 220)}`);
}
