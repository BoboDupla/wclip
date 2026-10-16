// Save raw HTML for each URL in urls.txt to fixtures/<slug>.html (+ .url).
// Mirrors webclip's order: honest UA first, browser UA only on failure/stub.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HONEST_UA = 'webclip-bakeoff/0.1 (+article clipper)';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const MIN_PLAUSIBLE_HTML = 2048;

async function get(url, ua) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
                                 signal: AbortSignal.timeout(30000), redirect: 'follow' });
    return r.ok ? await r.text() : null;
  } catch (e) { console.error(`  ${ua === HONEST_UA ? 'honest' : 'browser'} UA: ${e.cause?.message ?? e.message}`); return null; }
}

const force = process.argv.includes('--force');
for (const line of readFileSync('urls.txt', 'utf8').split('\n')) {
  const [slug, url] = line.trim().split(/\s+/);
  if (!slug || slug.startsWith('#') || !url) continue;
  if (existsSync(`fixtures/${slug}.html`) && !force) { console.log(`skip ${slug} (exists)`); continue; }
  let html = await get(url, HONEST_UA), ua = 'honest';
  if (!html || html.length < MIN_PLAUSIBLE_HTML) {
    const retry = await get(url, BROWSER_UA);
    if (retry && retry.length > (html?.length ?? 0)) { html = retry; ua = 'browser'; }
  }
  if (!html) { console.log(`FAIL ${slug} ${url}`); continue; }
  writeFileSync(`fixtures/${slug}.html`, html);
  writeFileSync(`fixtures/${slug}.url`, url + '\n');
  console.log(`ok   ${slug} ${html.length} bytes (${ua} UA)`);
}
