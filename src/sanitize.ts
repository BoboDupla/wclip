// One allowlist for extracted raw HTML and the final HTML/EPUB bodies. Markdown is
// tokenized, not fed to an HTML sanitizer: TeX, code fences and footnotes stay Markdown.
// Declarations are pinned in both the developer and bootstrap-tooling lockfiles.
import sanitizeHtml from 'sanitize-html';
import { Marked, type Token } from 'marked';
import { parseHTML } from 'linkedom';
import { randomUUID } from 'node:crypto';

const HTML_TAGS = `a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup
 dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd
 li main mark nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody
 td tfoot th thead time tr u ul var wbr`.split(/\s+/).filter(Boolean);
const MATH_TAGS = `math semantics annotation mrow mi mn mo mtext mfrac msup msub msubsup msqrt mroot
 mtable mtr mtd menclose mstyle mspace mover munder munderover mpadded mphantom mmultiscripts
 mprescripts none`.split(/\s+/).filter(Boolean);
const TAGS = new Set([...HTML_TAGS, ...MATH_TAGS]);
export { HTML_TAGS as ALLOWED_HTML_TAGS, TAGS, MATH_TAGS };
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// Require actual raster signatures; a Content-Type header (or .png filename) is not proof.
export function rasterImageType(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)) return 'image/png';
  const ascii = (a: number, z: number) => String.fromCharCode(...b.subarray(a, z));
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  const { document } = parseHTML(`<html><body><span>${s.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span></body></html>`);
  return document.body.textContent ?? '';
}

export function safeUrl(value: string, image = false): boolean {
  const decoded = decodeEntities(value);
  const s = decoded.replace(/[\u0000-\u0020\u007f-\u009f\s]/g, '');
  if (/^data:/i.test(s)) {
    if (!image || s.length > MAX_IMAGE_BYTES * 1.4) return false;
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(s);
    if (!m) return false;
    const bytes = Buffer.from(m[2], 'base64');
    return bytes.length <= MAX_IMAGE_BYTES && rasterImageType(bytes) === m[1].toLowerCase();
  }
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(s)?.[1].toLowerCase();
  if (scheme && !['http', 'https', ...(image ? [] : ['mailto'])].includes(scheme)) return false;
  try {
    const u = new URL(decoded.trim(), 'https://wclip.invalid/');
    return u.protocol === 'mailto:' ? !image : /^https?:$/.test(u.protocol) && !!u.hostname && !u.username && !u.password;
  } catch { return false; }
}

export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...TAGS],
    allowedAttributes: {
      '*': ['id', 'class', 'title', 'lang', 'dir', 'role', 'aria-label', 'aria-describedby', 'aria-hidden'],
      a: ['href', 'name', 'rel'], img: ['src', 'alt', 'width', 'height'],
      ol: ['start', 'reversed', 'type'], li: ['value'],
      td: ['colspan', 'rowspan', 'headers', 'align'], th: ['colspan', 'rowspan', 'scope', 'headers', 'align'],
      col: ['span', 'width'], colgroup: ['span'], details: ['open'], time: ['datetime'],
      math: ['xmlns', 'display'], annotation: ['encoding'],
      ...Object.fromEntries(MATH_TAGS.filter(t => t !== 'annotation' && t !== 'math').map(t => [t,
        ['mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'displaystyle', 'scriptlevel', 'stretchy',
         'symmetric', 'fence', 'separator', 'largeop', 'movablelimits', 'accent', 'accentunder', 'lspace',
         'rspace', 'minsize', 'maxsize', 'width', 'height', 'depth', 'voffset', 'linethickness', 'notation',
         'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'columnspan',
         'rowspan', 'frame', 'framespacing', 'equalrows', 'equalcolumns', 'side', 'position', 'bevelled']]))
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: true,
    // SVG, active containers and their fallback children are deliberately not retained.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'svg', 'form', 'template'],
    transformTags: {
      '*': (tag: string, attrs: Record<string, string>) => {
        if (attrs.href !== undefined && !safeUrl(attrs.href)) delete attrs.href;
        if (attrs.src !== undefined && !safeUrl(attrs.src, tag === 'img')) delete attrs.src;
        if (tag === 'math') attrs.xmlns = 'http://www.w3.org/1998/Math/MathML';
        return { tagName: tag, attribs: attrs };
      }
    }
  });
}

// Skip every backtick span and both fenced-code syntaxes, including an unclosed fence.
// A fresh prefix also makes literal WCMATHPH999Z (or another article's placeholders) inert.
// HTML attributes are not TeX. Record tag ranges in one scan so dollars in URLs,
// quoted attribute values and comments cannot hide markup from the sanitizer or
// replace part of an href with MathML. Malformed nested/unclosed tags stay bounded.
function htmlTagRanges(md: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 0; i < md.length;) {
    const start = md.indexOf('<', i);
    if (start < 0) break;
    if (md.startsWith('<!--', start)) {
      const end = md.indexOf('-->', start + 4);
      i = end < 0 ? md.length : end + 3;
      ranges.push([start, i]); continue;
    }
    let j = start + 1;
    if (md[j] === '/') j++;
    if (!/[A-Za-z]/.test(md[j] ?? '')) { i = j + 1; continue; }
    while (/[A-Za-z0-9:-]/.test(md[j] ?? '') && j < md.length) j++;
    if (j < md.length && !/[\s/>]/.test(md[j])) { i = j; continue; }
    let quote = '';
    for (; j < md.length; j++) {
      const c = md[j];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '<') break;
      if (c === '>') { j++; ranges.push([start, j]); break; }
    }
    i = Math.max(start + 1, j);
  }
  return ranges;
}

function nonMathRanges(md: string): [number, number][] {
  const ranges = htmlTagRanges(md);
  // Markdown destinations (including relative links) and reference definitions
  // must stay URLs even when a server legitimately uses dollar signs in a path.
  for (let i = 0; i < md.length;) {
    const marker = md.indexOf('](', i);
    if (marker < 0) break;
    let j = marker + 2;
    while (md[j] === ' ' || md[j] === '\t') j++;
    const start = j;
    if (md[j] === '<') {
      const close = md.indexOf('>', j + 1);
      j = close < 0 ? md.length : close + 1;
    } else {
      let nested = 0;
      for (; j < md.length; j++) {
        if (md[j] === '\\') { j++; continue; }
        if (/\s/.test(md[j])) break;
        if (md[j] === '(') nested++;
        if (md[j] === ')' && nested-- === 0) break;
      }
    }
    ranges.push([start, j]); i = Math.max(marker + 2, j);
  }
  for (const m of md.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<[^>\n]*>|[^\s]+)/gm)) ranges.push([m.index, m.index + m[0].length]);
  for (const m of md.matchAll(/(?:https?:\/\/|mailto:)[^\s<>"']+/gi)) ranges.push([m.index, m.index + m[0].length]);
  return ranges.sort((a, b) => a[0] - b[0]);
}

export function protectMath(md: string): { text: string; restore: (s: string, render?: (tex: string, display: boolean) => string) => string } {
  const tags = nonMathRanges(md);
  let tagCursor = 0;
  const prefix = `WCMATH${randomUUID().replace(/-/g, '')}PH`;
  const store: { raw: string; tex: string; display: boolean }[] = [];
  // Index exact backtick runs once. Repeatedly searching the remaining article
  // for unmatched delimiters of different lengths would itself be quadratic.
  const backticks = new Map<number, { positions: number[]; cursor: number }>();
  for (const run of md.matchAll(/`+/g)) {
    const size = run[0].length;
    if (!backticks.has(size)) backticks.set(size, { positions: [], cursor: 0 });
    backticks.get(size)!.positions.push(run.index);
  }
  const pattern = /(^ {0,3}(`{3,}|~{3,})[^\n]*\n)|(`+)|\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?=[^\s$])([^$\n]+?)(?<=[^\s$])\$/gm;
  let out = '', pos = 0, m: RegExpExecArray | null;
  while ((m = pattern.exec(md))) {
    out += md.slice(pos, m.index);
    if (m[1]) {
      const fence = m[2];
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, 'gm');
      close.lastIndex = pattern.lastIndex;
      const end = close.exec(md);
      pattern.lastIndex = end ? close.lastIndex : md.length;
      out += md.slice(m.index, pattern.lastIndex);
    } else if (m[3]) {
      const run = m[3];
      const indexed = backticks.get(run.length)!;
      while (indexed.positions[indexed.cursor] < pattern.lastIndex) indexed.cursor++;
      const end = indexed.positions[indexed.cursor];
      if (end !== undefined) pattern.lastIndex = end + run.length;
      out += md.slice(m.index, pattern.lastIndex);
    } else {
      while (tagCursor < tags.length && tags[tagCursor][1] <= m.index) tagCursor++;
      const crossesTag = tagCursor < tags.length && tags[tagCursor][0] < pattern.lastIndex;
      const tex = m[4] ?? m[5];
      if (crossesTag || (m[5] !== undefined && /\d/.test(md[pattern.lastIndex] ?? '') && !/[\\^_{}]/.test(tex))) out += m[0];
      else {
        out += `${prefix}${store.length}Z`;
        store.push({ raw: m[0], tex, display: m[4] !== undefined });
      }
    }
    pos = pattern.lastIndex;
  }
  out += md.slice(pos);
  return { text: out, restore: (s, render) => s.replace(new RegExp(`${prefix}(\\d+)Z`, 'g'), (raw, i: string) => {
    const item = store[Number(i)];
    return item ? render ? render(item.tex, item.display) : item.raw : raw;
  }) };
}

// Preserve a single inline HTML tag without the auto-closing that a fragment sanitizer
// normally adds. Multi-tag blocks are sanitized together, so raw tables keep their shape.
function sanitizeRawHtml(raw: string): string {
  const single = /^<(\/?)([a-z][\w:-]*)(?:\s[^<>]*)?\s*\/?>$/i.exec(raw);
  if (!single) return sanitizeBody(raw);
  const tag = single[2].toLowerCase();
  if (!TAGS.has(tag)) return '';
  if (single[1]) return `</${tag}>`;
  const sanitized = sanitizeBody(raw);
  return sanitized.slice(0, sanitized.indexOf('>') + 1);
}

const escapeMd = (s: string) => s.replace(/[\\`*_[\]{}()<>!$]/g, '\\$&');

// wclip never executes Markdown, but the note's viewer might: Obsidian runs Dataview and
// Templater fences and `$=` inline queries with vault access. A clipped page must not be
// able to turn itself into code in the vault that opens it.
const EXECUTABLE_FENCES = new Set(['dataview', 'dataviewjs', 'templater', 'templater-js', 'js-engine',
  'meta-bind', 'meta-bind-button', 'quickadd']);
// Inline Dataview JS queries start with `$=`. Inline DQL (`= expr`) is read-only and can
// stay, so ordinary `=formula` code examples keep their text.
const INLINE_QUERY = /^(`+)[ \t]*(\$=)/;

export function defangActiveCode(raw: string, codespan: boolean): string {
  if (codespan) {
    // A zero-width space after the opening backticks hides the `$=` prefix without
    // pretending to be different code.
    const m = INLINE_QUERY.exec(raw);
    return m ? `${m[1]}\u200b${raw.slice(m[1].length)}` : raw;
  }
  const m = /^([ \t]*(?:`{3,}|~{3,})[ \t]*)([^\s`]+)/.exec(raw);
  if (!m || !EXECUTABLE_FENCES.has(m[2].toLowerCase())) return raw;
  return `${m[1]}text${raw.slice(m[0].length)}`;
}

function sanitizeMarkdownPass(md: string, transformHtml: (raw: string) => string, preserveMath = true): string {
  // --stdout is also a terminal sink. Strip actual controls, not source examples
  // such as the four printable characters "\\x1b" inside a code fence.
  md = md.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  const math = preserveMath ? protectMath(md) : { text: md, restore: (s: string) => s };
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(math.text);
  function rewrite(token: Token): string {
    const t = token as Token & { href?: string; text?: string; tokens?: Token[]; items?: Token[]; header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };
    if (t.type === 'code') return defangActiveCode(t.raw, false);
    if (t.type === 'codespan') return defangActiveCode(t.raw, true);
    if (t.type === 'html') return sanitizeRawHtml(transformHtml(t.raw));
    if (['link', 'image', 'def'].includes(t.type) && !safeUrl(t.href ?? '', t.type === 'image'))
      return t.type === 'def' ? '' : escapeMd(t.text ?? '');
    const children = t.tokens ?? t.items ?? (t.type === 'table' ? [...t.header!, ...t.rows!.flat()].flatMap(c => c.tokens) : []);
    let raw = t.raw, offset = 0;
    for (const child of children) {
      const clean = rewrite(child);
      const index = raw.indexOf(child.raw, offset);
      if (index >= 0) {
        raw = raw.slice(0, index) + clean + raw.slice(index + child.raw.length);
        offset = index + clean.length;
      } else if (clean !== child.raw) {
        // Blockquote/list prefixes can interrupt a multi-line child's source. Fall back
        // only for this unsafe block, never for the whole document or ordinary Markdown.
        return sanitizeBody(marked.parse(t.raw, { async: false }) as string);
      }
    }
    return raw;
  }
  const clean = tokens.map(rewrite).join('');
  return math.restore(clean, (tex: string, display: boolean) => {
    // A math-unaware Markdown viewer must also be safe. Do not restore a masked
    // javascript link or raw HTML simply because dollars surrounded it.
    const safeTex = sanitizeMarkdownPass(tex, raw => raw, false);
    const delimiter = display ? '$$' : '$';
    return `${delimiter}${safeTex}${delimiter}`;
  });
}

export function sanitizeMarkdown(md: string, transformHtml: (raw: string) => string = raw => raw): string {
  // Removing a token can join neighbouring text into a new HTML tag/URL. Re-lex
  // until stable, with a strict pass budget. Deep adversarial joins fall back to
  // sanitized HTML rather than publishing still-active Markdown.
  const finish = (source: string): string => {
    // Validate the assembled result in a math-unaware renderer too. Token-local
    // safety is not enough: removal can alter parser context (including code
    // indentation inside a dollar span). Only adversarial/changed documents
    // fall back to sanitized HTML; ordinary Markdown remains byte-identical.
    const html = new Marked({ gfm: true }).parse(source, { async: false }) as string;
    const safe = sanitizeBody(html);
    const canonical = (s: string) => {
      const { document } = parseHTML(`<html><body>${s}</body></html>`);
      // GFM autolinks deliberately defanged hosts in security articles (graph[.]...)
      // which cannot navigate. Ignoring only syntactically invalid HTTP(S) attrs
      // avoids converting a whole legitimate article to HTML for that inert link.
      for (const el of document.querySelectorAll('[href], [src]')) {
        for (const name of ['href', 'src']) {
          const value = el.getAttribute(name);
          if (!value || !/^https?:/i.test(value.trim())) continue;
          try { new URL(value); } catch { el.removeAttribute(name); }
        }
      }
      return document.body.innerHTML;
    };
    return canonical(html) === canonical(safe) ? source : safe;
  };
  for (let pass = 0; pass < 4; pass++) {
    const clean = sanitizeMarkdownPass(md, transformHtml);
    if (clean === md) return finish(clean);
    md = clean;
  }
  return sanitizeBody(new Marked({ gfm: true }).parse(md, { async: false }) as string);
}

// An annotation is text, never HTML. Dollar delimiters and tag-like less-than signs
// cannot be allowed to terminate the math wrapper and inject Markdown/HTML afterwards.
export function safeAnnotationTex(tex: string): string {
  return tex.replace(/\$/g, '\\char36{}').replace(/<(?=\/?[A-Za-z][\w:-]*(?:\s|\/?>))/g, '\\lt{}');
}

export function markdownImage(alt: string, url: string): string {
  const label = alt.replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;')
    .replace(/[\\[\]<>]/g, c => `&#${c.charCodeAt(0)};`);
  const dest = url.replace(/[\u0000-\u0020\u007f<>\\()"']/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `![${label}](${dest})`;
}
