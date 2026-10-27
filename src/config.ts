// Config: same keys as the Python webclip, plus `browser` and `boilerplate`. Lives in
// ~/.config/wclip/; ~/.config/webclip/ is still read when the new file doesn't exist.
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ask, die, envVar, info, warn } from './util.js';

export interface Config {
  articles_dir: string;
  reading_wpm: number;
  include_images: boolean;
  make_html: boolean;
  make_epub: boolean;
  timeout: number;
  progress: boolean;
  openrouter: { api_key: string; model: string; timeout: number };
  properties: string[];
  custom_properties: Record<string, unknown>;
  browser: { mode: 'auto' | 'never'; executable: string; min_words: number; timeout: number };
  boilerplate: Record<string, string[]>;
}

// Known boilerplate, removed by selector. Defuddle's own content-pattern guessing is off,
// because it silently dropped real paragraphs (bakeoff/VERDICT.md). Keys are hosts; "*" applies everywhere.
export const DEFAULT_BOILERPLATE: Record<string, string[]> = {
  '*': ['[class^="cb_p6"]', '.cc-block', 'img[width="1"][height="1"]'],
  'ploum.net': ['div.signature'],
  'arstechnica.com': ['.upper-deck', '.pswp-caption-content'],
};

export const DEFAULTS: Config = {
  articles_dir: '~/apps/dufs/data/articles',
  reading_wpm: 200,
  include_images: true,
  make_html: true,
  make_epub: true,
  timeout: 30,
  progress: true,
  openrouter: { api_key: '', model: 'z-ai/glm-5.3-flash', timeout: 60 },
  properties: ['title', 'source', 'author', 'published', 'created', 'description', 'tags', 'read', 'reading time'],
  custom_properties: {},
  browser: { mode: 'auto', executable: '', min_words: 50, timeout: 45 },
  boilerplate: DEFAULT_BOILERPLATE,
};

export function configPath(): string {
  const env = envVar('CONFIG');
  if (env) return env.replace(/^~(?=$|\/)/, homedir());
  const current = join(homedir(), '.config', 'wclip', 'config.yaml');
  const legacy = join(homedir(), '.config', 'webclip', 'config.yaml');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
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
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const q = (s: string) => JSON.stringify(s);

export function renderConfig(c: { articles_dir: string; reading_wpm: number; api_key: string; model: string }): string {
  const bp = Object.entries(DEFAULT_BOILERPLATE)
    .map(([host, sels]) => `  ${q(host)}:\n` + sels.map(s => `    - ${q(s)}`).join('\n'))
    .join('\n');
  return `# wclip configuration
# Where clipped articles are saved:
articles_dir: ${c.articles_dir}

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

# OpenRouter: generates tags + summary. Leave api_key empty to use
# the OPENROUTER_API_KEY environment variable.
openrouter:
  api_key: ${q(c.api_key)}
  model: ${q(c.model)}
  timeout: 60

# Which frontmatter properties appear, and in what order.
# Known: title, source, author, published, created,
#        description, tags, read, reading time, site, license
properties:
${DEFAULTS.properties.map(p => `  - ${p}`).join('\n')}

# Static extra frontmatter properties, e.g.
#   type: article
custom_properties: {}

# Headless browser (Playwright + Chromium), used only as a last resort when
# the plain fetch gives nothing or a stub. mode: auto | never.
# executable: path to chromium/chrome; empty = Playwright's own browser,
# then $WCLIP_CHROMIUM, then chromium / google-chrome on $PATH.
browser:
  mode: auto
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
  mkdirSync(dirname(p), { recursive: true });
  const fd = openSync(p, 'w', 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  chmodSync(p, 0o600);
}

async function interactiveSetup(p: string): Promise<Config> {
  info("No config found — let's set up wclip.\n");
  const articles_dir = await ask('Where should clipped articles be saved?', join(homedir(), 'articles'));
  const api_key = await ask('OpenRouter API key (Enter to skip; you can also set OPENROUTER_API_KEY env var)', '');
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
  return cfg;
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
    data = parseYaml(readFileSync(p, 'utf8')) ?? {};
  } catch (e) {
    die(`config ${p} is not valid YAML: ${(e as Error).message}`);
  }
  if (!isObj(data)) die(`config ${p} is not a YAML mapping`);
  return deepMerge(DEFAULTS, data);
}
