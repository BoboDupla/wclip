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
  // --html runs read a local snapshot: never contact anything, not even an arXiv lookup.
  offline?: boolean;
  // Returns arXiv API Atom XML for an id, or null. Injectable so tests run offline.
  arxivLookup?: (id: string) => Promise<string | null>;
}

// Titles, bylines and descriptions reach the frontmatter, --stdout, a terminal and EPUB
// XHTML. Strip C0/C1 controls (XML 1.0 forbids most of them) and the bidi embedding
// controls used for Trojan-Source style reordering. U+200E/U+200F/U+061C are kept:
// they carry meaning in right-to-left text.
const META_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const cleanMeta = (s: string): string => s.replace(META_CONTROLS, '').replace(/\s+/g, ' ').trim();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
const fromCode = (n: number) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
// arXiv metadata arrives as Atom XML, where numeric references and &apos; are legal.
const decode = (s: string) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => fromCode(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => fromCode(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

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
  // A one- or two-character stem ("/a.jpg") matches half the page, so require a real name.
  if (!stem || stem.length < 3) return null;
  // The stem must be its own path segment, not a substring of another filename.
  const looksLikeStem = new RegExp(`(?:^|[/\\s,\"'])${escapeRe(stem)}(?![\\p{L}\\p{N}])`, 'iu');
  const img = [...document.querySelectorAll('body img')]
    .find(i => looksLikeStem.test(`${i.getAttribute('src') ?? ''} ${i.getAttribute('srcset') ?? ''}`) &&
               Number.parseInt(i.getAttribute('width') ?? '0', 10) >= 400);
  return img ? { stem, alt: img.getAttribute('alt') ?? '' } : null;
}

function restoreLeadImage(md: string, image: string, lead: { stem: string; alt: string } | null): string {
  if (!lead) return md;
  // Only an existing image reference counts. A prose mention of the stem ("banner") used
  // to suppress the legitimate hero image of any article that used that word.
  const stem = escapeRe(lead.stem);
  const alreadyThere = new RegExp(`!\\[[^\\]]*\\]\\([^)\\s]*${stem}|<img\\b[^>]*\\bsrc\\s*=\\s*[\"'][^\"']*${stem}`, 'i');
  if (alreadyThere.test(md)) return md;
  return `${markdownImage(lead.alt, image)}\n\n${md}`;
}

// A rel=license href is untrusted metadata: resolve it against the page and keep it only
// if it is a plain HTTP(S) URL.
function resolveLicense(href: string, pageUrl: string): string {
  if (!href.trim()) return '';
  let abs: string;
  try { abs = new URL(href.trim(), pageUrl).href; } catch { return ''; }
  return safeUrl(abs) && /^https?:/i.test(abs) ? abs : '';
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
  // An offline (--html) run must not generate traffic, not even for arXiv metadata.
  if (arxiv && !opts.offline) {
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
  // C0/C1 controls and bidi embeddings are not article content: they corrupt --stdout,
  // terminals and EPUB XHTML, and can reorder visible text (Trojan Source). U+200E,
  // U+200F and U+061C are deliberately kept for legitimate Arabic/Hebrew text.
  content = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
  return {
    content,
    title: cleanMeta(meta.title),
    author: cleanMeta(meta.author),
    published: parseDate(meta.published),
    site: cleanMeta(meta.site),
    description: cleanMeta(meta.description),
    license: resolveLicense(extra.license, url),
    image: safeUrl(r.image || ogImage, true) ? r.image || ogImage : '',
    words: wordCount(content),
  };
}
