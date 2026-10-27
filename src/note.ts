// Frontmatter + body. The exact shape is pinned by test/golden/note-expected.md.
import type { Config } from './config.js';
import { DEFAULTS } from './config.js';
import { normalizeTag, parseDate, readingTime, today, warn, wordCount } from './util.js';

export interface Fields {
  title: string;
  source: string;
  author: string; // comma-separated
  published: string;
  description: string;
  tags: string[];
  read: boolean;
  site?: string;
  license?: string;
}

// A JSON string is a valid YAML double-quoted scalar (YAML 1.2 is a JSON superset). JSON leaves
// U+0085/U+2028/U+2029 raw, but YAML reads them as line breaks, so those are escaped too.
const yamlStr = (s: string) =>
  JSON.stringify(String(s)).replace(/[\u0085\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const KNOWN = new Set(['title', 'source', 'author', 'published', 'created', 'description', 'tags', 'read', 'reading time', 'site', 'license']);

export function buildNote(f: Fields, content: string, cfg: Config): string {
  const props = cfg.properties?.length ? cfg.properties : DEFAULTS.properties;
  const lines = ['---'];
  for (const prop of props) {
    switch (prop) {
      case 'title': lines.push(`title: ${yamlStr(f.title)}`); break;
      case 'source': lines.push(`source: ${yamlStr(f.source)}`); break;
      case 'author': {
        const authors = f.author.split(',').map(a => a.trim()).filter(Boolean);
        lines.push('author:', ...authors.map(a => `  - ${yamlStr(a)}`));
        break;
      }
      case 'published': {
        // Always a YYYY-MM-DD date or empty, so a newline or mapping token cannot be
        // serialized into the frontmatter (parseDate is idempotent for that shape).
        const pub = parseDate(f.published);
        lines.push(pub ? `published: ${pub}` : 'published:');
        break;
      }
      case 'created': lines.push(`created: ${today()}`); break;
      case 'description': lines.push(`description: ${yamlStr(f.description)}`); break;
      case 'tags': {
        const tags = f.tags.map(normalizeTag).filter(Boolean);
        if (tags.length) lines.push('tags:', ...tags.map(t => `  - ${yamlStr(t)}`));
        else lines.push('tags: []');
        break;
      }
      case 'read': lines.push(`read: ${f.read ? 'true' : 'false'}`); break;
      case 'reading time': lines.push(`reading time: ${yamlStr(readingTime(wordCount(content), cfg.reading_wpm))}`); break;
      case 'site': lines.push(f.site ? `site: ${yamlStr(f.site)}` : 'site:'); break;
      case 'license': lines.push(f.license ? `license: ${yamlStr(f.license)}` : 'license:'); break;
      default: warn(`unknown property in config: ${prop} (skipped)`);
    }
  }
  for (const [k, v] of Object.entries(cfg.custom_properties ?? {})) {
    if (KNOWN.has(k)) {
      warn(`custom_properties key '${k}' collides with a known property (skipped)`);
      continue;
    }
    const key = /^[a-zA-Z_][a-zA-Z0-9_ -]*$/.test(k) ? k : yamlStr(k);
    if (Array.isArray(v)) lines.push(`${key}:`, ...v.map(item => `  - ${yamlStr(String(item))}`));
    else lines.push(`${key}: ${yamlStr(String(v))}`);
  }
  lines.push('---', '', content.trim(), '');
  return lines.join('\n');
}
