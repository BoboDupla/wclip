// Summarise out/<slug>.{defuddle,trafilatura}.{md,json} into report.md:
// word counts, metadata side by side, and paragraphs only one extractor kept.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const read = p => existsSync(p) ? readFileSync(p, 'utf8') : null;
const json = p => { const s = read(p); return s ? JSON.parse(s) : {}; };
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const paras = md => (md ?? '').split(/\n\s*\n/).map(p => p.trim()).filter(p => norm(p).split(' ').length >= 6);
const clip = s => s.replace(/\s+/g, ' ').slice(0, 160) + (s.length > 160 ? '…' : '');
const features = md => md == null ? '-' : [
  /^#{1,6} /m.test(md) && 'headings', /^\s*([-*+]|\d+\.) /m.test(md) && 'lists',
  /```|^ {4}\S/m.test(md) && 'code', /!\[/.test(md) && 'images', /\$[^$\n]+\$/.test(md) && 'math',
  /\[\^?\d+\]/.test(md) && 'footnotes', /^\|.*\|$/m.test(md) && 'tables',
].filter(Boolean).join(', ') || 'plain';

const slugs = [...new Set(readdirSync('out').map(f => f.replace(/\.(defuddle|trafilatura)\.(md|json)$/, '')))].sort();
let out = '# Bake-off: Defuddle vs current webclip (trafilatura)\n\n';
out += '| page | words D / T | ms D / T | structure D | structure T |\n|---|---|---|---|---|\n';
const detail = [];
for (const s of slugs) {
  const [dm, tm] = [read(`out/${s}.defuddle.md`), read(`out/${s}.trafilatura.md`)];
  const [dj, tj] = [json(`out/${s}.defuddle.json`), json(`out/${s}.trafilatura.json`)];
  out += `| ${s} | ${dj.wordCount ?? '-'} / ${tj.wordCount ?? '-'} | ${dj.ms ?? '-'} / ${tj.ms ?? '-'} | ${features(dm)} | ${features(tm)} |\n`;
  const [dp, tp] = [paras(dm), paras(tm)];
  const [dn, tn] = [new Set(dp.map(norm)), new Set(tp.map(norm))];
  const onlyD = dp.filter(p => !tn.has(norm(p))), onlyT = tp.filter(p => !dn.has(norm(p)));
  let d = `\n## ${s}\n\n| field | Defuddle | trafilatura |\n|---|---|---|\n`;
  for (const [label, a, b] of [['title', dj.title, tj.title], ['author', dj.author, tj.author],
       ['published', dj.published, tj.date], ['site', dj.site, tj.sitename], ['description', dj.description, tj.description]])
    d += `| ${label} | ${clip(a || '—')} | ${clip(b || '—')} |\n`;
  d += `\nParagraphs only Defuddle kept: ${onlyD.length}; only trafilatura kept: ${onlyT.length}.\n`;
  for (const [who, list] of [['Defuddle', onlyD], ['trafilatura', onlyT]])
    for (const p of list.slice(0, 5)) d += `- *${who} only:* ${clip(p)}\n`;
  detail.push(d);
}
writeFileSync('report.md', out + detail.join(''));
console.log(`report.md: ${slugs.length} pages`);
