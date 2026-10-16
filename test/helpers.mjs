// Shared helpers for the regression tests. Fixtures are the bake-off pages (bakeoff/fixtures).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../dist/config.js';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const GOLDEN = fileURLToPath(new URL('./golden/', import.meta.url));

export const slugs = readdirSync(FIXTURES).filter(f => f.endsWith('.url')).map(f => f.slice(0, -4)).sort();
export const fixtureHtml = slug => readFileSync(`${FIXTURES}${slug}.html`, 'utf8');
export const fixtureUrl = slug => readFileSync(`${FIXTURES}${slug}.url`, 'utf8').trim();

// arXiv API answers saved next to the fixtures, so tests run offline.
export async function offlineArxiv(id) {
  try { return readFileSync(`${FIXTURES}arxiv-api-${id}.atom`, 'utf8'); } catch { return null; }
}

export const extractOptions = { boilerplate: DEFAULTS.boilerplate, includeImages: true, arxivLookup: offlineArxiv };
