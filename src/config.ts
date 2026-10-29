// Config: articles_dir and friends, plus `browser` and `boilerplate`. Lives in
// ~/.config/wclip/config.yaml, or wherever $WCLIP_CONFIG points.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ask, die, envVar, info, warn } from './util.js';
import { readTextFileLimited, safeWriteFile } from './files.js';

export interface Config {
  articles_dir: string;
  reading_wpm: number;
  include_images: boolean;
  make_html: boolean;
  make_epub: boolean;
  timeout: number;
  progress: boolean;
  allow_private: boolean;
  cookies_file: string;
  openrouter: { enabled: boolean; api_key: string; model: string; timeout: number; data_collection: 'allow' | 'deny' };
  properties: string[];
  custom_properties: Record<string, unknown>;
  browser: { mode: 'auto' | 'never'; executable: string; min_words: number; timeout: number };
  boilerplate: Record<string, string[]>;
}

// Known boilerplate, removed by selector. Defuddle's own content-pattern guessing is off,
// because it silently dropped real paragraphs. Keys are hosts; "*" applies everywhere.
export const DEFAULT_BOILERPLATE: Record<string, string[]> = {
  '*': ['[class^="cb_p6"]', '.cc-block', 'img[width="1"][height="1"]'],
  'ploum.net': ['div.signature'],
  'arstechnica.com': ['.upper-deck', '.pswp-caption-content'],
};

export const DEFAULTS: Config = {
  articles_dir: '~/articles',
  reading_wpm: 200,
  include_images: true,
  make_html: true,
  make_epub: true,
  timeout: 30,
  progress: true,
  allow_private: false,
  // Netscape cookies.txt for subscriber-only sites. Empty = send no cookies at all.
  cookies_file: '',
  openrouter: { enabled: false, api_key: '', model: 'z-ai/glm-5.3-flash', timeout: 60, data_collection: 'allow' },
  properties: ['title', 'source', 'author', 'published', 'created', 'description', 'tags', 'read', 'reading time'],
  custom_properties: {},
  browser: { mode: 'never', executable: '', min_words: 50, timeout: 45 },
  boilerplate: DEFAULT_BOILERPLATE,
};

export function configPath(): string {
  const env = envVar('CONFIG');
  if (env) return env.replace(/^~(?=$|\/)/, homedir());
  return join(homedir(), '.config', 'wclip', 'config.yaml');
}

export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, homedir());
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const q = (s: string) => JSON.stringify(s).replace(/[\u0085\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function rejectUnsafeKeys(value: unknown, path = 'config', depth = 0): void {
  if (depth > 30) die('config is nested too deeply');
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) die(`unsafe key in ${path}`);
      rejectUnsafeKeys(v, `${path}.${k}`, depth + 1);
    }
  }
}

export function validateConfig(value: unknown): Config {
  rejectUnsafeKeys(value);
  if (!isObj(value)) die('config must be a mapping');
  const c = value;
  const fail = (name: string, expected: string): never => die(`invalid config ${name}: expected ${expected}`);
  const string = (v: unknown, name: string) => { if (typeof v !== 'string') fail(name, 'a string'); };
  const number = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max)
      fail(name, `an integer from ${min} to ${max}`);
  };
  const strings = (v: unknown, name: string) => {
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) fail(name, 'a list of strings');
  };
  string(c.articles_dir, 'articles_dir');
  if (!(c.articles_dir as string).trim()) fail('articles_dir', 'a non-empty path');
  string(c.cookies_file, 'cookies_file');
  number(c.reading_wpm, 'reading_wpm', 1, 10000);
  number(c.timeout, 'timeout', 1, 600);
  for (const k of ['include_images', 'make_html', 'make_epub', 'progress', 'allow_private']) {
    if (typeof c[k] !== 'boolean') fail(k, 'true or false');
  }
  if (!isObj(c.openrouter)) fail('openrouter', 'a mapping');
  const orc = c.openrouter as Record<string, unknown>;
  if (typeof orc.enabled !== 'boolean') fail('openrouter.enabled', 'true or false');
  string(orc.api_key, 'openrouter.api_key'); string(orc.model, 'openrouter.model');
  number(orc.timeout, 'openrouter.timeout', 1, 600);
  if (orc.data_collection !== 'allow' && orc.data_collection !== 'deny')
    fail('openrouter.data_collection', 'allow or deny');
  if (!isObj(c.browser)) fail('browser', 'a mapping');
  const b = c.browser as Record<string, unknown>;
  if (b.mode !== 'never' && b.mode !== 'auto') fail('browser.mode', 'never or auto');
  string(b.executable, 'browser.executable');
  number(b.timeout, 'browser.timeout', 1, 600); number(b.min_words, 'browser.min_words', 1, 100000);
  strings(c.properties, 'properties');
  if (!isObj(c.custom_properties)) fail('custom_properties', 'a mapping');
  for (const v of Object.values(c.custom_properties as Record<string, unknown>)) {
    const scalar = (x: unknown) => x === null || ['string', 'number', 'boolean'].includes(typeof x);
    if (!(Array.isArray(v) ? v.every(scalar) : scalar(v))) fail('custom_properties', 'scalar values or lists of scalars');
  }
  if (!isObj(c.boilerplate)) fail('boilerplate', 'a mapping of hosts to selector lists');
  for (const [host, sels] of Object.entries(c.boilerplate as Record<string, unknown>)) strings(sels, `boilerplate.${host}`);
  return c as unknown as Config;
}

export function renderConfig(c: { articles_dir: string; reading_wpm: number; api_key: string; model: string }): string {
  const bp = Object.entries(DEFAULT_BOILERPLATE)
    .map(([host, sels]) => `  ${q(host)}:\n` + sels.map(s => `    - ${q(s)}`).join('\n'))
    .join('\n');
  return `# wclip configuration
# Where clipped articles are saved:
articles_dir: ${q(c.articles_dir)}

# Words per minute used for "reading time":
reading_wpm: ${c.reading_wpm}

# Keep images in the clipped markdown:
include_images: true

# Also write an HTML rendition into <articles_dir>/html/:
make_html: true

# Also write an EPUB rendition into <articles_dir>/epub/:
make_epub: true

# HTTP timeout (seconds) for fetching pages:
timeout: 30

# Live status line while working (spinner + progress bar for EPUB images).
# Only drawn when stderr is a terminal; --no-progress and --quiet override it.
progress: true

# Allow local/intranet destinations only when you intend to clip them.
allow_private: false

# Netscape cookies.txt (exported from a logged-in browser) for sites that serve the full
# text only to subscribers. Cookies are sent to the host they belong to and nowhere else.
# Empty = send no cookies. --cookies FILE overrides this for one run.
cookies_file: ""

# OpenRouter receives up to 15000 characters of the article when explicitly enabled.
# An API key alone does not enable it. Prefer OPENROUTER_API_KEY in the environment.
# Saved HTML/private content still requires --llm for that run.
openrouter:
  enabled: false
  api_key: ${q(c.api_key)}
  model: ${q(c.model)}
  timeout: 60
  # allow | deny. "deny" asks OpenRouter to skip providers that may retain or train on
  # prompts. It can raise the price or fail if the model has no such provider.
  data_collection: allow

# Which frontmatter properties appear, and in what order.
# Known: title, source, author, published, created,
#        description, tags, read, reading time, site, license
properties:
${DEFAULTS.properties.map(p => `  - ${p}`).join('\n')}

# Static extra frontmatter properties, e.g.
#   type: article
custom_properties: {}

# Headless browser executes page JavaScript. Off by default: use --browser
# or explicitly opt into automatic fallback with mode: auto. mode: auto | never.
# executable: path to chromium/chrome; empty = Playwright's own browser,
# then $WCLIP_CHROMIUM, then chromium / google-chrome on $PATH.
browser:
  mode: never
  executable: ""
  min_words: 50   # fewer extracted words than this counts as a stub
  timeout: 45

# Boilerplate removed before extraction, as CSS selectors per host
# ("*" = every site). A host entry here replaces that host's defaults.
boilerplate:
${bp}
`;
}

export const DEFAULT_CONFIG_TEMPLATE = renderConfig({
  articles_dir: DEFAULTS.articles_dir,
  reading_wpm: DEFAULTS.reading_wpm,
  api_key: '',
  model: DEFAULTS.openrouter.model,
});

// Write with 0600 perms: the file may hold an API key.
export function writePrivate(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  safeWriteFile(p, text, false, 0o600);
}

async function interactiveSetup(p: string): Promise<Config> {
  info("No config found — let's set up wclip.\n");
  const articles_dir = await ask('Where should clipped articles be saved?', join(homedir(), 'articles'));
  // Never echo secrets into terminal scrollback. Keys can be provided in the environment
  // or edited into the private config; no secret is accepted on the command line.
  const api_key = '';
  info('OpenRouter is off by default. To use it, set OPENROUTER_API_KEY and pass --llm.');
  const model = await ask('OpenRouter model', DEFAULTS.openrouter.model);
  const wpm = await ask('Reading speed (words per minute)', String(DEFAULTS.reading_wpm));
  const reading_wpm = /^\d+$/.test(wpm) ? Number(wpm) : DEFAULTS.reading_wpm;
  const cfg = deepMerge(DEFAULTS, { articles_dir, reading_wpm, openrouter: { ...DEFAULTS.openrouter, api_key, model } });
  try {
    writePrivate(p, renderConfig({ articles_dir, reading_wpm, api_key, model }));
    info(`\nConfig written to ${p}`);
    info('(edit it any time to change properties order, custom properties, etc.)');
  } catch (e) {
    warn(`could not write config ${p}: ${(e as Error).message} (continuing with these settings for this run)`);
  }
  return validateConfig(cfg);
}

export async function loadConfig(): Promise<Config> {
  const p = configPath();
  if (!existsSync(p)) {
    if (process.stdin.isTTY) return interactiveSetup(p);
    try {
      writePrivate(p, DEFAULT_CONFIG_TEMPLATE);
      info(`No config found — wrote default config: ${p}`);
    } catch (e) {
      warn(`could not write default config ${p}: ${(e as Error).message} (using built-in defaults)`);
    }
    return DEFAULTS;
  }
  let data: unknown;
  try {
    data = parseYaml(readTextFileLimited(p, 1024 * 1024), { prettyErrors: false }) ?? {};
  } catch (e) {
    die(`could not read config ${p}: invalid YAML or unreadable/oversized input`);
  }
  if (!isObj(data)) die(`config ${p} is not a YAML mapping`);
  rejectUnsafeKeys(data);
  return validateConfig(deepMerge(DEFAULTS, data));
}
