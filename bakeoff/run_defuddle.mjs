// Extract every fixtures/*.html with Defuddle -> out/<slug>.defuddle.md (+ .json metadata).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';

for (const f of readdirSync('fixtures').filter(f => f.endsWith('.html')).sort()) {
  const slug = f.slice(0, -5);
  const url = existsSync(`fixtures/${slug}.url`) ? readFileSync(`fixtures/${slug}.url`, 'utf8').trim() : undefined;
  const { document } = parseHTML(readFileSync(`fixtures/${f}`, 'utf8'));
  const t0 = performance.now();
  try {
    // useAsync: false — never send the page to third-party APIs.
    const r = await Defuddle(document, url, { markdown: true, useAsync: false });
    const ms = Math.round(performance.now() - t0);
    writeFileSync(`out/${slug}.defuddle.md`, r.content ?? '');
    const { content, contentMarkdown, ...meta } = r;
    writeFileSync(`out/${slug}.defuddle.json`, JSON.stringify({ ...meta, ms }, null, 2));
    console.log(`defuddle    ${slug}: ${r.wordCount} words, ${ms} ms`);
  } catch (e) {
    console.log(`defuddle    ${slug}: ERROR ${e.message}`);
  }
}
