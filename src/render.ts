// HTML and EPUB renditions of a saved note, with $...$ / $$...$$ math rendered to MathML.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import temml from 'temml';
import { zipSync, strToU8 } from 'fflate';
import { parseHTML } from 'linkedom';
import { parse as parseYaml } from 'yaml';
import type { Config } from './config.js';
import { formatBytes, isVerbose, note as noteLine, startTask, type Task } from './status.js';
import { today, warn } from './util.js';
import { get } from './fetch.js';
import { safeWriteFile } from './files.js';
import { ALLOWED_HTML_TAGS, MAX_IMAGE_BYTES, TAGS, protectMath, rasterImageType, safeUrl, sanitizeBody } from './sanitize.js';

// XML 1.0 forbids most C0 controls even escaped, and they come from untrusted metadata.
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const esc = (s: string, quote = false) => {
  s = String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
// Tag-like tokens that are not HTML (<history_text>) come from prompt templates quoted in
// articles. Browsers hide them and EPUB's XHTML rejects them, so they are escaped. The
// sanitiser's own allowlist is included, so MathML inner elements (<mrow>, <mi>) survive
// to the MathML branch instead of being printed as literal text.
const HTML_TAGS = new Set([...TAGS, ...ALLOWED_HTML_TAGS, `a abbr address article aside b bdi bdo blockquote br caption center cite code
col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i
img ins kbd li main mark math nav ol p picture pre q rp rt ruby s samp section small source span strong
sub summary sup table tbody td tfoot th thead time tr u ul var video wbr`.split(/\s+/)]);

function mathToHtml(tex: string, display: boolean): string {
  try {
    return temml.renderToString(tex.trim(), { displayMode: display, throwOnError: true, annotate: true });
  } catch {
    return `<code>${esc(tex.trim())}</code>`; // unsupported TeX: keep the source visible
  }
}

export function renderMarkdown(md: string): string {
  const { text, restore } = protectMath(md);
  const marked = new Marked({ gfm: true }).use(markedFootnote()).use({ renderer: {
    // Marked, not our math scanner, is the authority on nested/indented code.
    // Restore any protected dollars inside code as escaped source, never MathML.
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang?.trim().split(/\s+/)[0];
      return `<pre><code${language ? ` class="language-${esc(language, true)}"` : ''}>${esc(restore(text).replace(/\n$/, ''))}\n</code></pre>\n`;
    },
    codespan({ text }: { text: string }) { return `<code>${esc(restore(text))}</code>`; },
    html({ text }: { text: string }) {
      const tag = /^<\/?([A-Za-z][\w-]*)\s*\/?>(?:\n)?$/.exec(text);
      return tag && !HTML_TAGS.has(tag[1].toLowerCase()) ? esc(text) : text;
    }
  } });
  // Footnote refs inside raw HTML tables keep Defuddle's "#fn:N" target; point them at marked-footnote's ids.
  const html = (marked.parse(text, { async: false }) as string).replace(/href="#fn:([\w-]+)"/g, 'href="#footnote-$1"');
  return sanitizeBody(restore(html, mathToHtml));
}

// --- XHTML for EPUB: re-serialize the HTML DOM as well-formed XML (void elements closed,
// named entities resolved, MathML/SVG namespaced, comments and scripts dropped).
const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
const NS: Record<string, string> = { math: 'http://www.w3.org/1998/Math/MathML', svg: 'http://www.w3.org/2000/svg' };
const xmlName = (n: string) => /^[A-Za-z_][\w.-]*$/.test(n);
function validHref(h: string): boolean {
  if (!safeUrl(h)) return false;
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
  const { document } = parseHTML(`<!doctype html><html><body>${sanitizeBody(html)}</body></html>`);
  return [...document.body.childNodes].map(n => toXhtml(n as unknown as Node)).join('');
}

// --- EPUB images: EPUB 3 does not allow remote images (epubcheck RSC-006), so they are
// downloaded into the book. An image that cannot be fetched is replaced by its alt text.
export interface EpubImage { path: string; type: string; data: Uint8Array }
export type ImageFetcher = (url: string) => Promise<{ type: string; data: Uint8Array } | null>;

const CORE_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};
const MAX_EPUB_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_EPUB_IMAGES = 128;

export function makeImageFetcher(userAgent: string, timeoutSec: number, allowPrivate = false): ImageFetcher {
  return async url => {
    try {
      if (!safeUrl(url, true) || !/^https?:/i.test(url)) return null;
      const r = await get(url, { 'User-Agent': userAgent }, timeoutSec, {},
        { allowPrivate, maxBytes: MAX_IMAGE_BYTES, maxDecodedBytes: MAX_IMAGE_BYTES });
      if (r.status < 200 || r.status >= 300) return null;
      const data = r.body;
      if (data.length > MAX_IMAGE_BYTES) return null;
      const type = rasterImageType(data);
      if (!type && (String(r.headers['content-type']).includes('svg') || /<svg\b/i.test(new TextDecoder().decode(data.subarray(0, 1024)))))
        warn('epub: SVG image omitted (active SVG content is not supported)');
      return type ? { type, data } : null;
    } catch {
      return null;
    }
  };
}

async function embedImages(document: Document, fetchImage: ImageFetcher, makeTask?: () => Task): Promise<EpubImage[]> {
  const imgs = [...document.querySelectorAll('img')];
  const byUrl = new Map<string, Promise<EpubImage | null>>();
  // Bound unique requests, not image elements, and never schedule omitted URLs again
  // during DOM replacement. Four workers bound in-flight memory as well as concurrency.
  const urls = [...new Set(imgs.map(img => img.getAttribute('src') ?? '').filter(u => /^https?:/i.test(u) && safeUrl(u, true)))];
  const queue = urls.slice(0, MAX_EPUB_IMAGES);
  if (urls.length > queue.length) warn(`epub: image count limit (${MAX_EPUB_IMAGES}) reached; additional images omitted`);
  const total = queue.length;
  const task = total ? makeTask?.() : undefined;
  let loaded = 0, bytes = 0, n = 0;
  let budgetExhausted = false;
  const tick = () => task?.progress(++loaded, total);
  task?.progress(0, total);
  const load = async (url: string, i: number): Promise<EpubImage | null> => {
    try {
      const r = await fetchImage(url);
      if (!r) return null;
      const type = rasterImageType(r.data);
      if (r.type === 'image/svg+xml') warn('epub: SVG image omitted (active SVG content is not supported)');
      if (!type || !CORE_IMAGE_TYPES[type] || r.data.length > MAX_IMAGE_BYTES) return null;
      if (bytes + r.data.length > MAX_EPUB_IMAGE_BYTES) {
        budgetExhausted = true;
        warn('epub: total image budget (60 MiB) reached; image omitted');
        return null;
      }
      bytes += r.data.length;
      return { path: `images/img${i}.${CORE_IMAGE_TYPES[type]}`, type, data: r.data };
    } catch { return null; }
    finally { tick(); }
  };
  const workers = Array.from({ length: 4 }, async () => { for (let u; !budgetExhausted && bytes < MAX_EPUB_IMAGE_BYTES && (u = queue.shift()); ) {
    // Stop scheduling once full; only the at-most-four already in-flight requests
    // can finish beyond the retained-payload budget. Do not fetch all 128 anyway.
    const pending = load(u, ++n);
    byUrl.set(u, pending);
    await pending;
  } });
  await Promise.all(workers);
  let failed = 0;
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    const got = await byUrl.get(src) ?? null;
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
  const out = (await Promise.all(byUrl.values())).filter((x): x is EpubImage => x !== null);
  task?.done(`${out.length} image(s)${failed ? `, ${failed} failed` : ''}`);
  return out;
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
  if (source && safeUrl(source)) byline += ` &middot; <a href="${esc(source, true)}">source</a>`;
  const sourceLink = source && safeUrl(source) ? `<a href="${esc(source, true)}">${esc(source)}</a>` : esc(source);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
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
<footer>Clipped from ${sourceLink} on ${esc(created)}</footer>
</article>
</body>
</html>
`;
}

export async function noteToEpub(note: string, stem: string, fetchImage: ImageFetcher | null,
                                  makeTask?: () => Task): Promise<Uint8Array> {
  const { fm, body } = parseNote(note);
  const { title, source, created, authors } = frontmatterBits(fm, stem);
  const { document } = parseHTML(`<!doctype html><html><body>${renderMarkdown(body)}</body></html>`);
  const images = fetchImage ? await embedImages(document as unknown as Document, fetchImage, makeTask) : [];
  const bodyX = [...document.body.childNodes].map(n => toXhtml(n as unknown as Node)).join('');
  const t = esc(title);
  const byline = authors.map(a => esc(a)).join(' &#183; '); // &middot; is not XML-declared
  const sourceLink = source && safeUrl(source) ? `<a href="${esc(source, true)}">${esc(source)}</a>` : esc(source);
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
    [cfg.make_epub, join(dirname(destMd), 'epub', `${stem}.epub`), () => noteToEpub(note, stem, fetchImage, () => startTask('embedding images'))],
  ];
  for (const [on, out, make] of jobs) {
    if (!on) continue;
    try {
      const data = await make();
      mkdirSync(dirname(out), { recursive: true });
      safeWriteFile(out, data, true);
      if (isVerbose()) noteLine(`  wrote ${out} (${formatBytes(typeof data === 'string' ? new TextEncoder().encode(data).length : data.length)})`);
    } catch (e) {
      warn(`could not write ${out.endsWith('.epub') ? 'epub' : 'html'} rendition: ${(e as Error).message}`);
    }
  }
}
