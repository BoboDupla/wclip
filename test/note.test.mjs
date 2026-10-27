// The note format is pinned by a golden note: any change here changes every future clip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, deepMerge } from '../dist/config.js';
import { buildNote } from '../dist/note.js';
import { parseTagsSummary } from '../dist/llm.js';
import { parseDate, sanitizeFilename, today, wordCount } from '../dist/util.js';
import { GOLDEN } from './helpers.mjs';

test('note matches the golden note byte for byte', () => {
  // Changing this output on purpose means updating test/golden/note-expected.md too.
  const c = JSON.parse(readFileSync(`${GOLDEN}note-case.json`, 'utf8'));
  const expected = readFileSync(`${GOLDEN}note-expected.md`, 'utf8').replace('{{created}}', today());
  assert.equal(buildNote(c.fields, c.content, deepMerge(DEFAULTS, c.cfg)), expected);
});

test('empty author, tags and published render as empty properties', () => {
  const note = buildNote({ title: 'T', source: 's', author: '', published: '', description: '', tags: [], read: false },
    'x', DEFAULTS);
  assert.match(note, /\nauthor:\npublished:\n/);
  assert.match(note, /\ntags: \[\]\n/);
});

test('optional site/license properties', () => {
  const cfg = deepMerge(DEFAULTS, { properties: ['title', 'site', 'license'] });
  const note = buildNote({ title: 'T', source: 's', author: '', published: '', description: '', tags: [], read: false,
    site: 'Smashing Frames', license: 'https://creativecommons.org/licenses/by-sa/4.0/' }, 'x', cfg);
  assert.equal(note, '---\ntitle: "T"\nsite: "Smashing Frames"\nlicense: "https://creativecommons.org/licenses/by-sa/4.0/"\n---\n\nx\n');
});

test('filenames and word counts follow the documented rules (Unicode-aware)', () => {
  assert.equal(sanitizeFilename('Hello, World! Ärger über Čapek_s — 2025'), 'hello-world-ärger-über-čapek-s-2025');
  assert.equal(sanitizeFilename('!!!'), 'untitled');
  assert.equal(wordCount("Hello world it's well-known, 3.5 and [link](http://x/y) ![](http://i) Čapek"), 9);
});

test('dates', () => {
  assert.equal(parseDate('2025-07-28T16:32:38+00:00'), '2025-07-28');
  assert.equal(parseDate('July 28, 2025'), '2025-07-28');
  assert.equal(parseDate('garbage'), '');
});

test('LLM response parsing: fences stripped, tags normalised and capped', () => {
  const r = parseTagsSummary('```json\n{"tags": ["Privacy", "web-tracking", "privacy", "android"], "summary": "Two\\nlines."}\n```');
  assert.deepEqual(r, { tags: ['privacy', 'webtracking', 'android'], summary: 'Twolines.' });
  assert.throws(() => parseTagsSummary('{"tags": "x", "summary": "y"}'), /tags must be a list/);
});
