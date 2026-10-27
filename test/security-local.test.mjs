// Security regressions: consent, config, diagnostics and user-owned output files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { DEFAULTS, deepMerge, validateConfig, renderConfig, writePrivate } from '../dist/config.js';
import { safeWriteFile, readTextFileLimited } from '../dist/files.js';
import { buildNote } from '../dist/note.js';
import { sanitizeFilename, terminalText } from '../dist/util.js';
import { llmTagsSummary } from '../dist/llm.js';

const dirs = [];
function dir() { const d = mkdtempSync(join(tmpdir(), 'wclip-local-')); dirs.push(d); return d; }
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/ploum-calendar.html', import.meta.url));
const source = 'https://ploum.net/2025-09-03-calendar-txt.html';

function run(args = [], override = {}) {
  const home = dir();
  const config = join(home, 'config.yaml');
  const preload = join(home, 'fetch.mjs');
  writeFileSync(config, `articles_dir: ${JSON.stringify(join(home, 'articles'))}\n` + override.config);
  // If the CLI tries the LLM, return an identifiable fixture, never contact OpenRouter.
  writeFileSync(preload, `globalThis.fetch = async () => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({tags:['consent','tested','fixture'],summary:'Explicit consent fixture.'})}}]}), {headers:{'content-type':'application/json'}});`);
  return spawnSync(process.execPath, ['--import', preload, CLI, '--html', fixture, source, '--stdout', ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, WCLIP_CONFIG: config, OPENROUTER_API_KEY: 'test-only-not-a-secret' },
  });
}

test('network, browser execution and LLM default to opt-in', () => {
  assert.equal(DEFAULTS.allow_private, false);
  assert.equal(DEFAULTS.browser.mode, 'never');
  assert.equal(DEFAULTS.openrouter.enabled, false);
  assert.equal(validateConfig(DEFAULTS), DEFAULTS);
});

test('API key alone is not LLM consent', () => {
  const r = run([], { config: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Explicit consent fixture.'));
  assert.ok(!r.stderr.includes('tags + summary via'));
});

test('saved HTML needs --llm even with a config opt-in', () => {
  const r = run([], { config: 'openrouter:\n  enabled: true\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Explicit consent fixture.'));
  assert.match(r.stderr, /require --llm/);
});

test('--llm explicitly consents for saved HTML and --no-llm suppresses generation', () => {
  const yes = run(['--llm'], { config: '' });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /Explicit consent fixture/);
  const no = run(['--no-llm'], { config: 'openrouter:\n  enabled: true\n' });
  assert.equal(no.status, 0, no.stderr);
  assert.ok(!no.stdout.includes('Explicit consent fixture.'));
  const conflict = run(['--llm', '--no-llm'], { config: '' });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /exclude each other/);
});

test('overridden tags and description cause no LLM call, even with --llm', () => {
  const r = run(['--llm', '-g', 'manual', '-d', 'Manual description'], { config: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('Explicit consent fixture.'));
  assert.ok(!r.stderr.includes('tags + summary via'));
});

test('LLM helper itself refuses to send when disabled', async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    assert.equal(await llmTagsSummary('title', 'body', DEFAULTS), null);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = saved; }
});

test('config rejects wrong types and out of range values with a field name', () => {
  for (const [override, field] of [
    [{ timeout: 'abc' }, 'timeout'], [{ timeout: 0 }, 'timeout'], [{ timeout: Infinity }, 'timeout'],
    [{ include_images: 'false' }, 'include_images'], [{ openrouter: { enabled: 'yes' } }, 'openrouter.enabled'],
    [{ browser: { mode: 'sometimes' } }, 'browser.mode'], [{ browser: { min_words: -1 } }, 'browser.min_words'],
    [{ boilerplate: { 'example.org': ['p', 1] } }, 'boilerplate'], [{ properties: [1] }, 'properties'],
    [{ custom_properties: { x: { nested: true } } }, 'custom_properties'],
  ]) assert.throws(() => validateConfig(deepMerge(DEFAULTS, override)), new RegExp(field));
});

test('prototype keys cannot alter merged configuration and are rejected by the loader', () => {
  const override = JSON.parse('{"__proto__":{"polluted":true},"browser":{"constructor":{"prototype":{"x":1}}}}');
  const result = deepMerge(DEFAULTS, override);
  assert.equal(result.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.throws(() => validateConfig(override), /unsafe key/);
  const r = run([], { config: '__proto__:\n  polluted: true\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unsafe key/);
});

test('wizard config safely quotes a path containing colon/newline/YAML line separators', () => {
  const path = 'a: b\nextra: nope\u2028tail';
  const text = renderConfig({ articles_dir: path, reading_wpm: 200, api_key: '', model: 'test' });
  const parsed = parseYaml(text);
  assert.equal(parsed.articles_dir, path);
  assert.equal(parsed.extra, undefined);
});

test('custom YAML keys cannot inject new fields', () => {
  const key = 'kind:\ninjected';
  const cfg = deepMerge(DEFAULTS, { custom_properties: { [key]: 'value' } });
  const text = buildNote({ title:'T',source:'s',author:'',published:'',description:'',tags:[],read:false }, 'body', cfg);
  const fm = parseYaml(text.split('---')[1]);
  assert.equal(fm[key], 'value');
  assert.equal(fm.injected, undefined);
});

test('UTF-8 filename leaves space for extensions and collision suffixes', () => {
  for (const name of ['漢'.repeat(150), 'é'.repeat(250), 'word '.repeat(500), '𠮷'.repeat(100)]) {
    const stem = sanitizeFilename(name);
    assert.ok(Buffer.byteLength(stem) <= 200);
    assert.ok(Buffer.byteLength(`${stem}-12345.epub`) < 255);
    assert.ok(!stem.includes('\ufffd'));
  }
});

test('diagnostics strip OSC/CSI/C1 and bidi controls but keep plain text', () => {
  const unsafe = '\x1b]52;c;YWJj\x07\x1b[2J\x9b31mTitle\u202e';
  const safe = terminalText(unsafe);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/.test(safe));
  assert.match(safe, /Title/);
  assert.equal(terminalText('A\nB\tC'), 'A\nB\tC');
});

test('atomic output creation refuses collisions and never follows symlinks', () => {
  const d = dir(), path = join(d, 'note.md'), target = join(d, 'target');
  safeWriteFile(path, 'first');
  assert.throws(() => safeWriteFile(path, 'second'), { code: 'EEXIST' });
  assert.equal(readFileSync(path, 'utf8'), 'first');
  safeWriteFile(path, 'authorised replacement', true);
  assert.equal(readFileSync(path, 'utf8'), 'authorised replacement');
  writeFileSync(target, 'do not touch');
  const symlink = join(d, 'link.md'); symlinkSync(target, symlink);
  for (const overwrite of [false, true]) assert.throws(() => safeWriteFile(symlink, 'evil', overwrite), /non-regular/);
  assert.equal(readFileSync(target, 'utf8'), 'do not touch');
  assert.ok(!readdirSync(d).some(p => p.endsWith('.part')));
});

test('config and config directory are private; existing config is not overwritten', () => {
  const d = dir(), p = join(d, 'private', 'config.yaml');
  writePrivate(p, 'hello');
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(d, 'private')).mode & 0o777, 0o700);
  assert.throws(() => writePrivate(p, 'overwrite'), { code: 'EEXIST' });
  assert.equal(readFileSync(p, 'utf8'), 'hello');
});

test('local input limits are enforced while reading and reject non-regular files', () => {
  const d = dir(), p = join(d, 'file.html'); writeFileSync(p, '123456');
  assert.throws(() => readTextFileLimited(p, 5), /exceeds/);
  assert.equal(readTextFileLimited(p, 6), '123456');
  assert.throws(() => readTextFileLimited(d, 100), /not a regular/);
});
