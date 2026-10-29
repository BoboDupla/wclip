#!/usr/bin/env node
// wclip — clip web articles to markdown notes with YAML frontmatter.
import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS, DEFAULT_CONFIG_TEMPLATE, configPath, expandHome, loadConfig, writePrivate, type Config } from './config.js';
import { loadCookieJar, type CookieJar } from './cookies.js';
import type { Article } from './extract.js';
import { HONEST_UA, VERSION } from './fetch.js';
import { llmTagsSummary } from './llm.js';
import { buildNote, type Fields } from './note.js';
import { getArticle } from './pipeline.js';
import { makeImageFetcher, writeExports } from './render.js';
import { WclipError, ask, closeInput, die, hostOf, info, normalizeUrl, parseDate, readingTime, sanitizeFilename, warn } from './util.js';
import { configureStatus, startTask, stopStatus } from './status.js';
import { readTextFileLimited, safeWriteFile } from './files.js';

const HELP = `usage: wclip [options] URL

Clip web articles to markdown notes with YAML frontmatter.

  wclip URL [options]        clip an article
  wclip -i [URL]             interactive: confirm/edit fields
  wclip --init-config        write a default config file

options:
  -i, --interactive        confirm/edit fields before saving
  -t, --title TITLE        override title
  -a, --author AUTHORS     override author (comma-separated); empty string clears
  -p, --published DATE     override published date (YYYY-MM-DD)
  -d, --description TEXT   override description (skips LLM summary)
  -g, --tags TAGS          override tags (comma-separated; skips LLM tags)
  -r, --read               mark as read
  -f, --force              overwrite existing note
      --stdout             print note instead of writing it
      --browser            fetch with the headless browser right away
      --no-browser         never use the headless browser
      --html FILE          extract from saved HTML (20 MiB limit; LLM off unless --llm)
      --cookies FILE       send subscriber cookies (Netscape cookies.txt) to the target host
      --llm                explicitly send article text to OpenRouter for this run
      --no-llm             never send article text to OpenRouter
      --allow-private      allow local/intranet requests (including page images)
  -v, --verbose            also show sizes, HTTP status and written files
  -q, --quiet              no progress lines; warnings, errors and the saved path only
      --no-progress        no live status line (plain lines instead)
      --init-config        write default config and exit
  -V, --version            print version
  -h, --help               show this help

A live status line (with a progress bar for EPUB image downloads) is drawn when
stderr is a terminal; set progress: false in the config or pass --no-progress
to get plain lines instead.

Config: ~/.config/wclip/config.yaml (override with $WCLIP_CONFIG)
`;

type Args = {
  url?: string; interactive?: boolean; title?: string; author?: string; published?: string; description?: string;
  tags?: string; read?: boolean; force?: boolean; stdout?: boolean; browser?: boolean; 'no-browser'?: boolean;
  html?: string; cookies?: string; verbose?: boolean; quiet?: boolean; 'no-progress'?: boolean;
  llm?: boolean; 'no-llm'?: boolean; 'allow-private'?: boolean;
};

// Subscriber cookies are opt-in per run (--cookies) or per config (cookies_file). Nothing is
// sent unless asked for, no value is ever echoed, and a --html run needs no network at all.
function resolveCookies(args: Args, cfg: Config): CookieJar | undefined {
  const file = args.cookies ?? cfg.cookies_file;
  if (!file) return undefined;
  if (args.html !== undefined) {
    warn('--cookies has no effect with --html: the saved file is read offline');
    return undefined;
  }
  const jar = (() => {
    try { return loadCookieJar(expandHome(file)); }
    catch (e) { die(`could not read cookies file ${file}: ${(e as Error).message}`); }
  })();
  if (!jar.count) die(`cookies file ${file} contains no usable cookies`);
  return jar;
}

async function fetchArticle(url: string, cfg: Config, args: Args, cookies?: CookieJar): Promise<Article> {
  if (cookies && !cookies.header(url)) warn(`no cookie in the file matches ${hostOf(url)}; fetching unauthenticated`);
  const task = startTask(args.html !== undefined ? `reading ${basename(args.html)}` : `fetching ${hostOf(url)}`);
  return getArticle(url, cfg, {
    browser: args.browser ? 'always' : args['no-browser'] ? 'never' : undefined,
    html: args.html !== undefined ? readTextFileLimited(args.html, 20 * 1024 * 1024) : undefined,
    cookies,
    task,
  });
}

// Only calls OpenRouter when its values would be used (property present and not overridden),
// to avoid needless disclosure of article content and API cost.
async function gatherFields(url: string, art: Article, cfg: Config, args: Args): Promise<Fields> {
  const title = args.title || art.title || url;
  const props = cfg.properties?.length ? cfg.properties : DEFAULTS.properties;
  const needTags = props.includes('tags') && args.tags === undefined;
  const needDesc = props.includes('description') && args.description === undefined;
  const enabled = !args['no-llm'] && (args.llm || cfg.openrouter.enabled);
  // Allowing private network access conservatively marks the whole run as sensitive,
  // including public URLs whose redirects/subresources may have reached an intranet.
  const consent = args.llm || (args.html === undefined && !cfg.allow_private);
  if (enabled && !consent && (needTags || needDesc)) info('OpenRouter skipped: saved HTML/private-network runs require --llm.');
  const llm = enabled && consent && (needTags || needDesc)
    ? await llmTagsSummary(title, art.content, { ...cfg, openrouter: { ...cfg.openrouter, enabled: true } }) : null;
  return {
    title,
    source: url,
    author: args.author !== undefined ? args.author : art.author,
    published: parseDate(args.published || art.published),
    description: args.description ?? llm?.summary ?? '',
    tags: args.tags !== undefined ? args.tags.split(',').map(t => t.trim()).filter(Boolean) : llm?.tags ?? [],
    read: Boolean(args.read),
    site: art.site,
    license: art.license,
  };
}

async function writeNote(dest: string, note: string, cfg: Config, overwrite = false): Promise<void> {
  mkdirSync(join(dest, '..'), { recursive: true });
  try { safeWriteFile(dest, note, overwrite); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') die(`already clipped: ${dest}\n(use --force to overwrite or -i to rename)`);
    throw e;
  }
  info(`Clipped: ${dest}`);
  await writeExports(dest, note, cfg, cfg.include_images ? makeImageFetcher(HONEST_UA, cfg.timeout, cfg.allow_private) : null);
}

async function interactiveClip(url: string, args: Args, cfg: Config, cookies?: CookieJar): Promise<void> {
  if (!url) url = await ask('URL');
  if (!url) die('no URL given');
  url = normalizeUrl(url);
  const art = await fetchArticle(url, cfg, args, cookies);
  info('Extracted:');
  info(`  title:     ${art.title || url}`);
  info(`  author:    ${art.author || '(unknown)'}`);
  info(`  published: ${art.published || '(unknown)'}`);
  info(`  words:     ${art.words}`);
  info('');
  const f = await gatherFields(url, art, cfg, args);
  process.stderr.write('\n');
  f.title = await ask('Title', f.title);
  f.author = await ask('Author(s), comma-separated', f.author);
  f.description = await ask('Description', f.description);
  f.published = parseDate(await ask('Published (YYYY-MM-DD)', f.published));
  f.tags = (await ask('Tags (comma-separated)', f.tags.join(', '))).split(',').map(t => t.trim()).filter(Boolean);
  f.read = (await ask('Mark as read? (y/N)', 'n')).toLowerCase().startsWith('y');
  const note = buildNote(f, art.content, cfg);
  const dir = expandHome(cfg.articles_dir);
  let dest = join(dir, `${sanitizeFilename(f.title)}.md`);
  let overwrite = false;
  info(`\nWill write: ${dest}`);
  if (existsSync(dest)) {
    const choice = (await ask('File exists. (o)verwrite / (r)ename / (a)bort', 'a')).toLowerCase();
    if (choice.startsWith('r')) {
      for (let i = 2; existsSync(dest); i++) dest = join(dir, `${sanitizeFilename(f.title)}-${i}.md`);
      info(`Renamed to: ${dest}`);
    } else if (choice.startsWith('o')) overwrite = true;
    else die('aborted');
  }
  if ((await ask('Save? (Y/n)', 'y')).toLowerCase().startsWith('n')) die('aborted');
  await writeNote(dest, note, cfg, overwrite);
}

async function batchClip(url: string, args: Args, cfg: Config, cookies?: CookieJar): Promise<void> {
  const art = await fetchArticle(url, cfg, args, cookies);
  const f = await gatherFields(url, art, cfg, args);
  const note = buildNote(f, art.content, cfg);
  if (args.stdout) {
    process.stdout.write(note + '\n');
    return;
  }
  const dest = join(expandHome(cfg.articles_dir), `${sanitizeFilename(f.title)}.md`);
  if (existsSync(dest) && !args.force) die(`already clipped: ${dest}\n(use --force to overwrite or -i to rename)`);
  await writeNote(dest, note, cfg, Boolean(args.force));
  info(`title: ${f.title} | ${art.words} words | ${readingTime(art.words, cfg.reading_wpm)}`);
  if (!f.tags.length && args.tags === undefined && (cfg.openrouter.enabled || args.llm) && !args['no-llm'])
    info('note: tags/description empty (OpenRouter skipped, unavailable or failed)');
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        interactive: { type: 'boolean', short: 'i' }, title: { type: 'string', short: 't' },
        author: { type: 'string', short: 'a' }, published: { type: 'string', short: 'p' },
        description: { type: 'string', short: 'd' }, tags: { type: 'string', short: 'g' },
        read: { type: 'boolean', short: 'r' }, force: { type: 'boolean', short: 'f' },
        stdout: { type: 'boolean' }, browser: { type: 'boolean' }, 'no-browser': { type: 'boolean' },
        html: { type: 'string' }, cookies: { type: 'string' },
        verbose: { type: 'boolean', short: 'v' }, quiet: { type: 'boolean', short: 'q' },
        'no-progress': { type: 'boolean' }, 'init-config': { type: 'boolean' },
        llm: { type: 'boolean' }, 'no-llm': { type: 'boolean' }, 'allow-private': { type: 'boolean' },
        version: { type: 'boolean', short: 'V' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    info(`error: ${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values.version) { process.stdout.write(`wclip ${VERSION}\n`); return 0; }
  if (positionals.length > 1) die(`expected one URL, got ${positionals.length}`);
  const args: Args = { ...values, url: positionals[0] };
  if (args.browser && args['no-browser']) die('--browser and --no-browser exclude each other');
  if (args.llm && args['no-llm']) die('--llm and --no-llm exclude each other');
  if (args.cookies !== undefined && !args.cookies.trim()) die('--cookies needs a file path');

  if (values['init-config']) {
    const p = configPath();
    if (existsSync(p)) die(`config already exists: ${p}`);
    writePrivate(p, DEFAULT_CONFIG_TEMPLATE);
    info(`Wrote default config: ${p}`);
    return 0;
  }
  const loaded = await loadConfig();
  const cfg: Config = { ...loaded, allow_private: Boolean(args['allow-private'] || loaded.allow_private) };
  const cookies = resolveCookies(args, cfg);
  configureStatus({
    verbose: Boolean(args.verbose),
    quiet: Boolean(args.quiet),
    progress: args['no-progress'] ? false : cfg.progress,
  });
  if (args.interactive) await interactiveClip(args.url ?? '', args, cfg, cookies);
  else if (args.url) await batchClip(normalizeUrl(args.url), args, cfg, cookies);
  else { process.stderr.write(HELP); return 1; }
  return 0;
}

process.on('SIGINT', () => { stopStatus(); process.stderr.write('\naborted\n'); process.exit(130); });
// exitCode, not exit(): exit() can cut off a large note still being piped from --stdout.
main().finally(closeInput).then(code => { process.exitCode = code; }, e => {
  stopStatus();
  if (e instanceof WclipError) info(`error: ${e.message}`);
  else info(`error: ${(e as Error).message ?? e}`);
  process.exitCode = 1;
});
