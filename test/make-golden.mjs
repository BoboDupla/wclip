// Regenerate test/golden from the current extractor. Review the git-style diff before committing to new goldens.
import { writeFileSync } from 'node:fs';
import { extract } from '../dist/extract.js';
import { GOLDEN, slugs, fixtureHtml, fixtureUrl, extractOptions } from './helpers.mjs';

for (const slug of slugs) {
  const { content, ...meta } = await extract(fixtureHtml(slug), fixtureUrl(slug), extractOptions);
  writeFileSync(`${GOLDEN}${slug}.md`, content + '\n');
  writeFileSync(`${GOLDEN}${slug}.json`, JSON.stringify(meta, null, 2) + '\n');
  console.log(slug, meta.words);
}
