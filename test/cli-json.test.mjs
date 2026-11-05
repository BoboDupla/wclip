// --json is a contract with the web layer: one object on stdout, nothing on stderr,
// exit 0 for "wrote it" and "already there", exit 1 with ok:false for anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const fixture = join(root, 'test/fixtures/alxgsv-let-me-check.html');
const sourceUrl = 'https://blog.alxgsv.com/let-me-check/';
const work = mkdtempSync(join(tmpdir(), 'wclip-json-'));
const articles = join(work, 'articles');
const configPath = join(work, 'config.yaml');
writeFileSync(configPath, [
  `articles_dir: ${articles}`,
  'include_images: false',
  'make_html: true',
  'make_epub: true',
  'progress: false',
  'openrouter:',
  '  enabled: false',
  '',
].join('\n'));

function wclip(args) {
  const out = spawnSync('node', [join(root, 'dist/cli.js'), ...args], {
    cwd: root,
    env: { ...process.env, WCLIP_CONFIG: configPath, TERM: 'dumb' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = (out.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  let result = null;
  try { result = JSON.parse(line); } catch { result = null; }
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '', result };
}

test('--json writes one object and stays quiet', () => {
  const run = wclip(['--html', fixture, '--json', '-t', 'JSON contract', sourceUrl]);
  assert.equal(run.stderr, '', 'nothing on stderr in machine mode');
  assert.equal(run.status, 0);
  assert.ok(run.result, `stdout was not JSON: ${JSON.stringify(run.stdout)}`);
  assert.equal(run.result.ok, true);
  assert.equal(run.result.existing, false);
  assert.equal(run.result.path, join(articles, 'json-contract.md'));
  assert.equal(run.result.title, 'JSON contract');
  assert.ok(Array.isArray(run.result.warnings));
  assert.match(readFileSync(run.result.path, 'utf8'), /^---\n/);

  const again = wclip(['--html', fixture, '--json', '-t', 'JSON contract', sourceUrl]);
  assert.equal(again.status, 0, 'an existing note is a result, not a failure');
  assert.equal(again.result.existing, true);
  assert.equal(again.result.path, run.result.path);
});

test('--json reports a failure as ok:false with exit 1', () => {
  const run = wclip(['--html', join(work, 'missing.html'), '--json', sourceUrl]);
  assert.equal(run.status, 1);
  assert.equal(run.result.ok, false);
  assert.match(run.result.error, /missing\.html/);
  assert.equal(run.stderr, '');
});

test('--json keeps warnings out of stderr and inside the result', () => {
  const run = wclip(['--html', fixture, '--json', '--cookies', join(work, 'jar.txt'),
    '-t', 'Warned', sourceUrl]);
  assert.equal(run.stderr, '');
  assert.equal(run.result.ok, true);
  assert.ok(run.result.warnings.some(w => /--cookies has no effect with --html/.test(w)),
    `warnings were ${JSON.stringify(run.result.warnings)}`);
});

test('--json refuses to share stdout with --stdout', () => {
  const run = wclip(['--html', fixture, '--json', '--stdout', sourceUrl]);
  assert.notEqual(run.status, 0);
});

test.after(() => rmSync(work, { recursive: true, force: true }));
