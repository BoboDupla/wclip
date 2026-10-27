// Defuddle plus one named fix per known extraction failure; test/extract.test.mjs pins each of them.
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import { get, HONEST_UA } from './fetch.js';
import { hostOf, parseDate, warn, wordCount } from './util.js';
import { randomUUID } from 'node:crypto';
import { markdownImage, safeAnnotationTex, safeUrl, sanitizeMarkdown } from './sanitize.js';

export interface Article {
  content: string; // markdown
  title: string;
  author: string; // comma-separated
  published: string; // YYYY-MM-DD or ''
  site: string;
  description: string; // the page's own description (not the LLM summary)
  license: string;
  image: string;
  words: number;
}

export interface ExtractOptions {
  boilerplate: Record<string, string[]>;
  includeImages: boolean;
  // Returns arXiv API Atom XML for an id, or null. Injectable so tests run offline.
  arxivLookup?: (id: string) => Promise<string | null>;
}

// Selectors for a host: "*" plus every key that is the host or a parent domain of it.
function selectorsFor(map: Record<string, string[]>, host: string): string[] {
  return Object.entries(map)
    .filter(([k]) => k === '*' || host === k || host.endsWith(`.${k}`))
    .flatMap(([, v]) => (Array.isArray(v) ? v : []));
}

function preprocess(document: Document, host: string, boilerplate: Record<string, string[]>): { license: string } {
  // License: keep it as metadata before the visible block goes.
  const license = document.querySelector('a[rel="license"], link[rel="license"]')?.getAttribute('href') ?? '';
  // Fix 1: known boilerplate removed by selector instead of Defuddle's content-pattern guessing.
  for (const sel of selectorsFor(boilerplate, host)) {
    try {
      document.querySelectorAll(sel).forEach(el => el.remove());
    } catch {
      warn(`boilerplate selector is not valid CSS, skipped: ${sel}`);
    }
  }
  // arXiv's placeholder alt text; Defuddle would turn it into a caption.
  document.querySelectorAll('img[alt="Refer to caption"]').forEach(img => img.setAttribute('alt', ''));
  // Defuddle's author cleanup also retries overlapping whitespace patterns.
  // Normalize metadata whitespace before entering that dependency, not just our
  // own byline fix afterwards. Metadata whitespace is not article/code content.
  for (const meta of [...document.querySelectorAll('meta')]) {
    const key = `${meta.getAttribute('name') ?? ''} ${meta.getAttribute('property') ?? ''}`;
    if (/author|creator|\bbyl\b/i.test(key))
      meta.setAttribute('content', (meta.getAttribute('content') ?? '').replace(/\s+/g, ' ').trim());
  }
  // Nested <math> roots are malformed MathML, and thousands of unclosed roots
  // overflow the dependency's recursive DOM clone before postprocessing runs.
  // Keep their visible text without feeding that invalid tree to Defuddle.
  for (const math of [...document.querySelectorAll('math')]) {
    if (!math.parentElement?.closest('math') && math.querySelector('math'))
      math.replaceWith(document.createTextNode(math.textContent ?? ''));
  }
  // An annotation is text. Do not let an embedded dollar or HTML-looking source
  // break out of the math delimiters when Defuddle converts it to Markdown.
  for (const annotation of [...document.querySelectorAll('math annotation')])
    annotation.textContent = safeAnnotationTex(annotation.textContent ?? '');
  // Fix 2: Defuddle keeps only the first <img> of a <figure>; split multi-image figures,
  // one figure per panel with the caption on the last. (Bare <p><img> panels get dropped.)
  for (const fig of [...document.querySelectorAll('figure')]) {
    const imgs = [...fig.querySelectorAll('img')];
    if (imgs.length < 2) continue;
    const cap = fig.querySelector('figcaption');
    const parts = imgs.map((img, i) => {
      const f = document.createElement('figure');
      f.appendChild(img.cloneNode(true));
      if (cap && i === imgs.length - 1) f.appendChild(cap.cloneNode(true));
      return f;
    });
    fig.replaceWith(...parts);
  }
  // Fix 5: text boxes drawn as SVG (arXiv/LaTeXML tcolorbox) become a blockquote of their
  // foreignObject HTML; otherwise the whole <svg> lands in the Markdown as raw markup.
  for (const svg of [...document.querySelectorAll('svg')]) {
    const fos = [...svg.querySelectorAll('foreignObject, foreignobject')];
    if (!fos.length) continue;
    const bq = document.createElement('blockquote');
    fos.forEach((fo, i) => {
      const titled = i === 0 && fos.length > 1;
      const box = document.createElement(titled ? 'p' : 'div');
      if (titled) {
        const b = document.createElement('strong');
        b.textContent = (fo.textContent ?? '').trim();
        box.appendChild(b);
      } else {
        while (fo.firstChild) box.appendChild(fo.firstChild);
      }
      bq.appendChild(box);
    });
    svg.replaceWith(bq);
  }
  return { license };
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function postprocess(md: string, description: string): string {
  // Defuddle escapes "<trait>" but not "<trait\_description>"; unescaped, it reads as an HTML tag and vanishes.
  md = md.replace(/(^|[^\\])<(\/?[a-z][a-z0-9]*(?:\\_[a-z0-9]+)+)>/gm, '$1\\<$2>');
  // With content patterns off, Defuddle no longer drops a lede that repeats the description,
  // and it leaves an identical paragraph twice in a row (Ars image credits).
  const paras = md.split(/\n\s*\n/).filter((p, i, a) => i === 0 || norm(p) !== norm(a[i - 1]));
  const i = paras.findIndex(p => norm(p).length > 0);
  const d = norm(description);
  if (i >= 0 && d && norm(paras[i]).startsWith(d)) {
    const rest = paras[i].slice(description.length).trim();
    if (norm(paras[i]) === d || norm(rest) === norm(paras[i]).slice(d.length).trim()) paras[i] = rest;
    if (!paras[i]) paras.splice(i, 1);
  }
  // Fix 3: parse raw HTML chunks once, rather than retrying an unbounded regex
  // at every unmatched <math>. Never decode annotation text into HTML markup.
  return sanitizeMarkdown(paras.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(), raw => {
    if (!/<math\b/i.test(raw)) return raw;
    const { document } = parseHTML(`<html><body>${raw}</body></html>`);
    const prefix = `WCTEX${randomUUID().replace(/-/g, '')}PH`;
    const tex: string[] = [];
    for (const math of [...document.querySelectorAll('math')]) {
      const annotation = math.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"], annotation');
      if (!annotation) continue;
      const token = `${prefix}${tex.length}Z`;
      tex.push(`$${safeAnnotationTex(annotation.textContent ?? '').trim()}$`);
      math.replaceWith(document.createTextNode(token));
    }
    return document.body.innerHTML.replace(new RegExp(`${prefix}(\\d+)Z`, 'g'), (_, i: string) => tex[Number(i)]);
  });
}

// Fix 6: lead image. Defuddle drops some hero images that readers do see (Ars piracy article:
// og:image is an <img> in the page, only its credit line survived; tante's featured image).
// If the page body shows its og:image at a declared width of 400px or more (so not a logo, like
// ploum's decorative header) and the output never mentions that file, put it back on top.
function leadImage(document: Document, image: string): { stem: string; alt: string } | null {
  if (!safeUrl(image, true) || !/^https?:/i.test(image)) return null;
  const stem = /\/([^/?#]+?)(?:-\d+x\d+)?\.(?:jpe?g|png|webp|gif|avif)$/i.exec(new URL(image).pathname)?.[1];
  if (!stem) return null;
  const img = [...document.querySelectorAll('body img')]
    .find(i => `${i.getAttribute('src') ?? ''} ${i.getAttribute('srcset') ?? ''}`.includes(stem) &&
               Number.parseInt(i.getAttribute('width') ?? '0', 10) >= 400);
  return img ? { stem, alt: img.getAttribute('alt') ?? '' } : null;
}

function restoreLeadImage(md: string, image: string, lead: { stem: string; alt: string } | null): string {
  if (!lead || md.includes(lead.stem)) return md;
  return `${markdownImage(lead.alt, image)}\n\n${md}`;
}

// Fix 4: metadata. Byline-style author ("Ploum on 2025-09-03"), date from the byline or URL,
// site from og:site_name or the host, arXiv from its API (the HTML rendition has no author/date meta).
async function fixMeta(r: { title: string; author: string; published: string; site: string; description: string },
                       url: string, document: Document, opts: ExtractOptions) {
  const host = hostOf(url);
  const m = { title: r.title ?? '', author: r.author ?? '', published: r.published ?? '', site: r.site ?? '',
              description: r.description ?? '' };
  // Match the fixed-size suffix first. A lazy prefix followed by overlapping
  // whitespace quantifiers was quadratic on a long, attacker-controlled byline.
  const byline = /\bon\s+(\d{4}-\d{2}-\d{2})$/.exec(m.author);
  if (byline && byline.index > 0 && /\s/.test(m.author[byline.index - 1])) {
    m.author = m.author.slice(0, byline.index).trimEnd();
    m.published ||= byline[1];
  }
  if (!m.site || m.site === r.author)
    m.site = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? host;
  m.published ||= /(\d{4})[-/](\d{2})[-/](\d{2})/.exec(new URL(url).pathname)?.slice(1).join('-') ?? '';
  const arxiv = (host === 'arxiv.org' || host.endsWith('.arxiv.org')) &&
    /\/(?:html|abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/.exec(new URL(url).pathname);
  if (arxiv) {
    const atom = await (opts.arxivLookup ?? arxivApi)(arxiv[1] + (arxiv[2] ?? ''));
    const entry = atom?.split('<entry>')[1] ?? '';
    if (entry) {
      const tag = (t: string) => decode(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(entry)?.[1] ?? '').replace(/\s+/g, ' ').trim();
      m.title = tag('title') || m.title;
      m.author = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map(x => x[1].trim()).join(', ') || m.author;
      m.published = tag('published').slice(0, 10) || m.published;
      m.description = tag('summary') || m.description;
    } else {
      warn('arXiv API lookup failed; author and date may be missing');
    }
    m.site = 'arXiv';
  }
  return m;
}

export async function arxivApi(id: string): Promise<string | null> {
  try {
    const r = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
      { 'User-Agent': HONEST_UA }, 20, {}, { maxBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024 });
    return r.status >= 200 && r.status < 300 ? new TextDecoder().decode(r.body) : null;
  } catch {
    return null;
  }
}

// Defuddle's own network access is for async extractors (YouTube, Reddit, X...) and the
// third-party API fallback. useAsync:false already disables those; this makes any leftover
// request fail loudly instead of sending the page somewhere.
const noFetch = (async (input: unknown) => {
  throw new Error(`wclip: Defuddle tried to fetch ${String(input)}; network access from the extractor is disabled`);
}) as typeof fetch;

export async function extract(html: string, url: string, opts: ExtractOptions): Promise<Article> {
  const maxBytes = 20 * 1024 * 1024;
  if (html.length > maxBytes || Buffer.byteLength(html, 'utf8') > maxBytes)
    throw new Error('extraction input exceeds 20 MiB limit');
  const { document } = parseHTML(html);
  const host = hostOf(url);
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '';
  const lead = leadImage(document as unknown as Document, ogImage);
  const extra = preprocess(document as unknown as Document, host, opts.boilerplate);
  const r = await Defuddle(document as unknown as Document, url, {
    markdown: true,
    useAsync: false, // never fall back to third-party APIs
    fetch: noFetch,
    removeContentPatterns: false, // Fix 1 (cont.): it silently dropped real paragraphs
    removeImages: !opts.includeImages,
  });
  const meta = await fixMeta(r, url, document as unknown as Document, opts);
  let content = postprocess(r.content ?? '', meta.description);
  if (opts.includeImages) content = restoreLeadImage(content, ogImage, lead);
  content = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  return {
    content,
    title: meta.title,
    author: meta.author,
    published: parseDate(meta.published),
    site: meta.site,
    description: meta.description,
    license: extra.license,
    image: safeUrl(r.image || ogImage, true) ? r.image || ogImage : '',
    words: wordCount(content),
  };
}
