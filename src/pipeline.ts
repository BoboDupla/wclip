// Fetch order: honest UA -> browser UA (only on failure, a stub, or nothing extracted)
// -> headless browser (only when that still yields nothing or a stub).
import type { Config } from './config.js';
import { fetchWithBrowser } from './browser.js';
import { extract, type Article, type ExtractOptions } from './extract.js';
import { BROWSER_UA, HONEST_UA, MIN_PLAUSIBLE_HTML, fetchPage, type Page } from './fetch.js';
import { formatBytes, isVerbose, note, type Task } from './status.js';
import { die, info, warn } from './util.js';

export interface FetchMode {
  browser?: 'auto' | 'never' | 'always';
  html?: string; // pre-fetched HTML (--html FILE)
  task?: Task; // live status line owned by the caller
  // Test hooks.
  extractOptions?: Partial<ExtractOptions>;
  fetchBrowser?: typeof fetchWithBrowser;
}

export async function getArticle(url: string, cfg: Config, mode: FetchMode = {}): Promise<Article> {
  const opts: ExtractOptions = {
    boilerplate: cfg.boilerplate, includeImages: cfg.include_images,
    offline: mode.html !== undefined, // --html never touches the network
    ...mode.extractOptions,
  };
  const run = async (p: Page | null) => {
    if (!p) return null;
    // Extraction is synchronous and can take seconds on big pages, so say so before it starts.
    mode.task?.setDetail('extracting');
    return extract(p.html, p.url, opts);
  };
  const minWords = cfg.browser.min_words;
  const browserMode = mode.browser ?? cfg.browser.mode;

  if (mode.html !== undefined) {
    const a = await run({ html: mode.html, url, via: 'file' });
    if (!a?.content) {
      mode.task?.fail();
      die('could not extract readable content from that file');
    }
    mode.task?.done(`${a.words} words`);
    return a;
  }

  let page: Page | null = null;
  let art: Article | null = null;
  if (browserMode !== 'always') {
    page = await fetchPage(url, HONEST_UA, cfg.timeout, {}, { allowPrivate: cfg.allow_private });
    art = await run(page);
    if (!page || page.html.length < MIN_PLAUSIBLE_HTML || !art?.content) {
      mode.task?.setDetail('retrying with a browser user agent');
      const retry = await fetchPage(url, BROWSER_UA, cfg.timeout, {}, { allowPrivate: cfg.allow_private });
      // Only take the retry if it is bigger: decoys served to browser UAs are small (tante.cc: 1.1 KB).
      if (retry && retry.html.length > (page?.html.length ?? 0)) {
        const a = await run(retry);
        if (a?.content) [page, art] = [retry, a];
      }
    }
  }

  const stub = !art?.content || art.words < minWords;
  if (browserMode === 'always' || (browserMode === 'auto' && stub)) {
    if (browserMode === 'auto') mode.task?.setDetail(`only ${art?.words ?? 0} words; starting a headless browser`);
    const bpage = await (mode.fetchBrowser ?? fetchWithBrowser)(url, cfg.browser.executable, cfg.browser.timeout, { allowPrivate: cfg.allow_private });
    const a = await run(bpage);
    if (a?.content && (browserMode === 'always' || a.words > (art?.words ?? 0))) [page, art] = [bpage, a];
  }

  if (!page) {
    mode.task?.fail();
    die(`could not fetch ${url}`);
  }
  if (!art?.content) {
    mode.task?.fail();
    die('could not extract readable content from that page.\n' +
        'Hint: JavaScript is off by default; use --browser with sandbox-capable Chromium installed;\n' +
        'or save the page from your browser and run: wclip --html saved.html URL');
  }
  if (art.words < minWords) warn(`only ${art.words} words extracted; the page may need JavaScript or be paywalled`);
  const bytes = page.bytes ? formatBytes(page.bytes) : `${Math.round(page.html.length / 1024)} KB of HTML`;
  const extra = isVerbose() ? ` (HTTP ${page.status ?? '?'}, ${page.ms ?? 0} ms)` : '';
  mode.task?.done(`${bytes} from ${page.via}, ${art.words} words${extra}`);
  if (isVerbose()) note(`  source: ${page.url}`);
  return art;
}
