// HTML and EPUB renditions of a saved note, with $...$ / $$...$$ math rendered to MathML.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import temml from 'temml';
import { zipSync, strToU8 } from 'fflate';
import { parseHTML } from 'linkedom';
import { parse as parseYaml } from 'yaml';
import type { Config } from './config.js';
import { today, warn } from './util.js';

const esc = (s: string, quote = false) => {
  s = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return quote ? s.replace(/"/g, '&quot;').replace(/'/g, '&#x27;') : s;
};

export function parseNote(note: string): { fm: Record<string, unknown>; body: string } {
  if (note.startsWith('---')) {
    const i = note.indexOf('\n---\n');
    if (i >= 0) {
      let fm: unknown = {};
      try { fm = parseYaml(note.slice(3, i)) ?? {}; } catch { fm = {}; }
      return { fm: typeof fm === 'object' && fm && !Array.isArray(fm) ? fm as Record<string, unknown> : {}, body: note.slice(i + 5).trim() };
    }
  }
  return { fm: {}, body: note.trim() };
}

// --- math: Markdown would turn _ and * inside TeX into emphasis, so every math span is swapped
// for an opaque placeholder before Markdown runs and rendered to MathML afterwards. Code spans and
// fenced blocks are left alone, and a single $ only opens math when a non-space character follows
// it and a non-space character precedes the closing $ (so "$5 and $10" stays text).
// Tag-like tokens that are not HTML (<history_text>) come from prompt templates quoted in articles.
// Browsers hide them and EPUB's XHTML rejects them, so they are escaped.
const HTML_TAGS = new Set(`a abbr address article aside b bdi bdo blockquote br caption center cite code
col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i
img ins kbd li main mark math nav ol p picture pre q rp rt ruby s samp section small source span strong
sub summary sup table tbody td tfoot th thead time tr u ul var video wbr`.split(/\s+/));
const MATH_OR_CODE = /(```[\s\S]*?```|`[^`\n]+`)|\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?=[^\s$])([^$\n]+?)(?<=[^\s$])\$|(<\/?([A-Za-z][\w-]*)(?=[\s/>])[^<>\n]*>)/g;
const PLACEHOLDER = /WCMATHPH(\d+)Z/g;

function protectMath(md: string): { text: string; store: [string, boolean][] } {
  const store: [string, boolean][] = [];
  const text = md.replace(MATH_OR_CODE, (all, code, display, inline, tag, name, offset: number, s: string) => {
    if (code !== undefined) return code;
    if (display !== undefined) { store.push([display, true]); return `WCMATHPH${store.length - 1}Z`; }
    if (inline !== undefined) {
      // "$5 ... $6"-style money: a digit right after the closing $ and no TeX syntax inside.
      if (/\d/.test(s[offset + all.length] ?? '') && !/[\\^_{}]/.test(inline)) return all;
      store.push([inline, false]);
      return `WCMATHPH${store.length - 1}Z`;
    }
    return HTML_TAGS.has(name.toLowerCase()) ? tag : esc(tag);
  });
  return { text, store };
}

function mathToHtml(tex: string, display: boolean): string {
  try {
    return temml.renderToString(tex.trim(), { displayMode: display, throwOnError: true, annotate: true });
  } catch {
    return `<code>${esc(tex.trim())}</code>`; // unsupported TeX: keep the source visible
  }
}

export function renderMarkdown(md: string): string {
  const { text, store } = protectMath(md);
  const marked = new Marked({ gfm: true }).use(markedFootnote());
  // Footnote refs inside raw HTML tables keep Defuddle's "#fn:N" target; point them at marked-footnote's ids.
  const html = (marked.parse(text, { async: false }) as string).replace(/href="#fn:([\w-]+)"/g, 'href="#footnote-$1"');
  return store.length ? html.replace(PLACEHOLDER, (_, i: string) => mathToHtml(...store[Number(i)])) : html;
}

// --- XHTML for EPUB: re-serialize the HTML DOM as well-formed XML (void elements closed,
// named entities resolved, MathML/SVG namespaced, comments and scripts dropped).
const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
const NS: Record<string, string> = { math: 'http://www.w3.org/1998/Math/MathML', svg: 'http://www.w3.org/2000/svg' };
const xmlName = (n: string) => /^[A-Za-z_][\w.-]*$/.test(n);
function validHref(h: string): boolean {
  if (!/^[a-z][\w+.-]*:/i.test(h)) return true; // relative or fragment
  try {
    const u = new URL(h);
    return !/^https?:$/.test(u.protocol) || /^[\w.-]+$/.test(u.hostname);
  } catch {
    return false;
  }
}

function toXhtml(node: Node): string {
  if (node.nodeType === 3) return esc(node.textContent ?? '');
  if (node.nodeType !== 1) return node.nodeType === 11 || node.nodeType === 9 ? [...node.childNodes].map(toXhtml).join('') : '';
  const el = node as Element;
  const name = el.localName;
  const tag = name.toLowerCase();
  if (tag === 'script' || tag === 'style' || !xmlName(tag)) return [...el.childNodes].map(toXhtml).join('');
  let attrs = '';
  for (const a of [...el.attributes]) {
    if (!xmlName(a.name) || a.name === 'xmlns') continue;
    if (a.name === 'href' && !validHref(a.value)) continue; // e.g. defanged "https://graph\\[.\\]facebook..." autolinks
    attrs += ` ${a.name}="${esc(a.value, true)}"`;
  }
  if (NS[tag]) attrs += ` xmlns="${NS[tag]}"`;
  const inner = [...el.childNodes].map(toXhtml).join('');
  return inner || !VOID.has(tag) ? `<${name}${attrs}>${inner}</${name}>` : `<${name}${attrs}/>`;
}

export function htmlToXhtml(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return [...document.body.childNodes].map(n => toXhtml(n as unknown as Node)).join('');
}

// --- EPUB images: EPUB 3 does not allow remote images (epubcheck RSC-006), so they are
// downloaded into the book. An image that cannot be fetched is replaced by its alt text.
export interface EpubImage { path: string; type: string; data: Uint8Array }
export type ImageFetcher = (url: string) => Promise<{ type: string; data: Uint8Array } | null>;

const CORE_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
};
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function sniffImageType(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg/.test(new TextDecoder().decode(b.subarray(0, 256)))) return 'image/svg+xml';
  return '';
}

export function makeImageFetcher(userAgent: string, timeoutSec: number): ImageFetcher {
  return async url => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(timeoutSec * 1000) });
      if (!r.ok) return null;
      const data = new Uint8Array(await r.arrayBuffer());
      if (data.length > MAX_IMAGE_BYTES) return null;
      const type = sniffImageType(data) || (r.headers.get('content-type') ?? '').split(';')[0].trim();
      return CORE_IMAGE_TYPES[type] ? { type, data } : null;
    } catch {
      return null;
    }
  };
}

async function embedImages(document: Document, fetchImage: ImageFetcher): Promise<EpubImage[]> {
  const imgs = [...document.querySelectorAll('img')];
  const byUrl = new Map<string, Promise<EpubImage | null>>();
  let n = 0;
  const load = (url: string) => {
    if (!byUrl.has(url)) {
      const i = ++n;
      byUrl.set(url, fetchImage(url).then(r => r && { path: `images/img${i}.${CORE_IMAGE_TYPES[r.type]}`, ...r }));
    }
    return byUrl.get(url)!;
  };
  // At most 4 downloads at a time.
  const queue = imgs.map(img => img.getAttribute('src') ?? '').filter(u => /^https?:/.test(u));
  const workers = Array.from({ length: 4 }, async () => { for (let u; (u = queue.shift()); ) await load(u); });
  await Promise.all(workers);
  let failed = 0;
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    const got = /^https?:/.test(src) ? await load(src) : null;
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    if (got) {
      img.setAttribute('src', got.path);
      if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
    } else {
      failed++;
      const alt = img.getAttribute('alt')?.trim();
      if (alt) img.replaceWith(document.createTextNode(`[image: ${alt}]`));
      else img.remove();
    }
  }
  if (failed) warn(`epub: ${failed} image(s) could not be downloaded and were left out`);
  const out = await Promise.all(byUrl.values());
  return out.filter((x): x is EpubImage => x !== null);
}

function frontmatterBits(fm: Record<string, unknown>, stem: string) {
  const authors = (Array.isArray(fm.author) ? fm.author : fm.author ? [fm.author] : []).map(String).filter(a => a.trim());
  return {
    title: String(fm.title || stem),
    source: String(fm.source || ''),
    created: String(fm.created || today()),
    authors,
  };
}

const HTML_STYLE = `body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.6;
       font-size: 1.25rem;
       max-width: 42em; margin: 2em auto; padding: 0 1em; color: #1a1a1a; }
h1, h2, h3 { line-height: 1.25; }
h1 { font-size: 1.7em; margin-bottom: 0.2em; }
.byline { color: #555; font-size: 0.95em; margin-bottom: 2em; }
.byline a { color: #555; }
img { max-width: 100%; height: auto; }
pre, code { font-family: ui-monospace, Menlo, monospace; }
pre { overflow-x: auto; padding: 0.8em; background: #f5f5f5; border-radius: 4px; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ccc; color: #444; }
table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 0.2em 0.5em; }
footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid #ddd;
          font-size: 0.85em; color: #777; word-break: break-all; }`;

export function noteToHtml(note: string, stem: string): string {
  const { fm, body } = parseNote(note);
  const { title, source, created, authors } = frontmatterBits(fm, stem);
  let byline = authors.map(a => esc(a)).join(' &middot; ');
  if (source) byline += ` &middot; <a href="${esc(source, true)}">source</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${HTML_STYLE}
</style>
</head>
<body>
<article>
<h1>${esc(title)}</h1>
<div class="byline">${byline}</div>
${renderMarkdown(body)}
<footer>Clipped from <a href="${esc(source, true)}">${esc(source)}</a> on ${esc(created)}</footer>
</article>
</body>
</html>
`;
}

export async function noteToEpub(note: string, stem: string, fetchImage: ImageFetcher | null): Promise<Uint8Array> {
  const { fm, body } = parseNote(note);
  const { title, source, created, authors } = frontmatterBits(fm, stem);
  const { document } = parseHTML(`<!doctype html><html><body>${renderMarkdown(body)}</body></html>`);
  const images = fetchImage ? await embedImages(document as unknown as Document, fetchImage) : [];
  const bodyX = [...document.body.childNodes].map(n => toXhtml(n as unknown as Node)).join('');
  const t = esc(title);
  const byline = authors.map(a => esc(a)).join(' &#183; '); // &middot; is not XML-declared
  const sourceLink = source ? `<a href="${esc(source, true)}">${esc(source)}</a>` : '';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>${t}</title>
<style>
body { font-family: serif; line-height: 1.6; margin: 1em; }
h1 { font-size: 1.5em; }
.byline { color: #555; font-style: italic; margin-bottom: 1.5em; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ccc; }
img { max-width: 100%; }
</style></head>
<body>
<h1>${t}</h1>
<div class="byline">${byline}</div>
${bodyX}
<p><small>Clipped from ${sourceLink} on ${esc(created)}.</small></p>
</body></html>`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const hasMath = bodyX.includes('<math');
  const remote = /<(?:img|source|video|audio)\b[^>]*\ssrc="https?:/.test(bodyX);
  const props = [hasMath && 'mathml', remote && 'remote-resources'].filter(Boolean).join(' ');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${randomUUID()}</dc:identifier>
    <dc:title>${t}</dc:title>
    ${authors.map(a => `<dc:creator>${esc(a)}</dc:creator>`).join('')}
    <dc:language>en</dc:language>
    <dc:date>${esc(created)}</dc:date>
    <dc:source>${esc(source, true)}</dc:source>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"${props ? ` properties="${props}"` : ''}/>
${images.map((im, i) => `    <item id="img${i + 1}" href="${im.path}" media-type="${im.type}"/>`).join('\n')}
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc"><ol><li><a href="content.xhtml">${t}</a></li></ol></nav>
</body></html>`;
  // mimetype must be first and STORED (uncompressed) per the EPUB spec.
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/content.xhtml': strToU8(content),
    // Images are already compressed; storing them saves time for nothing lost.
    ...Object.fromEntries(images.map(im => [`OEBPS/${im.path}`, [im.data, { level: 0 }]])),
  });
}

// Write <articles_dir>/html/<name>.html and <articles_dir>/epub/<name>.epub (best-effort).
export async function writeExports(destMd: string, note: string, cfg: Config, fetchImage: ImageFetcher | null): Promise<void> {
  const stem = basename(destMd, '.md');
  const jobs: [boolean, string, () => string | Uint8Array | Promise<Uint8Array>][] = [
    [cfg.make_html, join(dirname(destMd), 'html', `${stem}.html`), () => noteToHtml(note, stem)],
    [cfg.make_epub, join(dirname(destMd), 'epub', `${stem}.epub`), () => noteToEpub(note, stem, fetchImage)],
  ];
  for (const [on, out, make] of jobs) {
    if (!on) continue;
    try {
      const data = await make();
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, data);
    } catch (e) {
      warn(`could not write ${out.endsWith('.epub') ? 'epub' : 'html'} rendition: ${(e as Error).message}`);
    }
  }
}
