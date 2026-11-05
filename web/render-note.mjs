// Lazy rendition helper: turn one existing note into html/ and epub/ siblings
// using wclip's own renderer, so there is exactly one implementation of the
// markdown -> HTML/EPUB path. Invoked as: node render-note.mjs /path/to/note.md
//
// The compiled wclip modules are loaded from WCLIP_DIST when set, otherwise from
// ~/.local/share/wclip/dist (a source install). Nothing here imports from npm.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const dest = process.argv[2];
if (!dest || !dest.endsWith('.md')) {
  console.error('usage: node render-note.mjs /path/to/note.md');
  process.exit(2);
}

const dist = process.env.WCLIP_DIST || `${homedir()}/.local/share/wclip/dist`;
const { writeExports, makeImageFetcher } = await import(pathToFileURL(`${dist}/render.js`).href);
const { HONEST_UA } = await import(pathToFileURL(`${dist}/fetch.js`).href);

const note = readFileSync(dest, 'utf8');
if (!note.trim()) {
  console.error('empty note');
  process.exit(1);
}
const cfg = { make_html: true, make_epub: true };
const fetchImage = makeImageFetcher(HONEST_UA, 30, false);
await writeExports(dest, note, cfg, fetchImage);
