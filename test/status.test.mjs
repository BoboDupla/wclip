// Progress output: live line only on a terminal, plain lines when piped, stdout stays pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatBytes, formatDuration, renderBar } from '../dist/status.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const URL_ = 'https://ploum.net/2025-09-03-calendar-txt.html';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'wclip-status-'));
  const cfg = join(dir, 'config.yaml');
  writeFileSync(cfg, `articles_dir: ${join(dir, 'articles')}\n`);
  return { dir, cfg };
}

// -g and -d keep the LLM out of the run, so these tests stay offline.
function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, '--html', `${FIXTURES}ploum-calendar.html`, URL_, '-g', 'x', '-d', 'y', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

// `script` gives the child a pty, which is the only way to exercise the animated path.
const hasScript = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;

test('sizes, durations and bars', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB');
  assert.equal(formatDuration(400), '0.4 s');
  assert.equal(formatDuration(9400), '9.4 s');
  assert.equal(formatDuration(23500), '24 s');
  assert.equal(formatDuration(125000), '2 m 05 s');
  assert.equal(renderBar(0, 8), '[----------------]');
  assert.equal(renderBar(4, 8), '[########--------]');
  assert.equal(renderBar(8, 8), '[################]');
  assert.equal(renderBar(3, 0), '');
});

test('piped stderr gets plain lines, never escape codes', () => {
  const { cfg } = sandbox();
  const r = run(['--stdout'], { WCLIP_CONFIG: cfg });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /reading ploum-calendar\.html \.\.\./);
  assert.match(r.stderr, /^ok \d+ words in /m);
  assert.ok(!r.stderr.includes('\x1b'), 'no ANSI escapes when stderr is not a terminal');
  // --stdout stays pure: the note only.
  assert.ok(!r.stdout.includes('\x1b'));
  assert.ok(!/^ok /m.test(r.stdout));
  assert.match(r.stdout, /^---\ntitle: /);
});

test('on a terminal the line is animated and then cleared', { skip: !hasScript && 'no script(1) for a pty' }, () => {
  const { cfg } = sandbox();
  // TERM is "dumb" under some test runners, which correctly disables the live line.
  const r = spawnSync('script', ['-qec',
    `TERM=xterm-256color WCLIP_CONFIG=${cfg} ${process.execPath} ${CLI} --html ${FIXTURES}ploum-calendar.html ${URL_} -g x -d y`, '/dev/null'],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // script(1) merges the pty's stdout and stderr into its own stdout.
  const out = r.stdout;
  assert.match(out, /\x1b\[2K/, 'draws the line');
  assert.match(out, /\r/, 'returns to the start of the line');
  assert.match(out, /ok \d+ words in /);
});

test('--quiet drops the progress lines but keeps the saved path', () => {
  const { dir, cfg } = sandbox();
  const r = run(['--quiet'], { WCLIP_CONFIG: cfg });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/reading /.test(r.stderr), r.stderr);
  assert.ok(!/^ok /m.test(r.stderr), r.stderr);
  assert.match(r.stderr, /Clipped: .*how-i-fell-in-love-with-calendartxt\.md/);
  assert.match(readFileSync(join(dir, 'articles', 'how-i-fell-in-love-with-calendartxt.md'), 'utf8'), /^---/);
});

test('--verbose adds timings and the written files', () => {
  const { cfg } = sandbox();
  const r = run(['--verbose'], { WCLIP_CONFIG: cfg });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /wrote .*\.html \(\d+ KB\)/);
  assert.match(r.stderr, /wrote .*\.epub \(/);
});

test('progress: false in the config disables the live line', { skip: !hasScript && 'no script(1) for a pty' }, () => {
  const { dir, cfg } = sandbox();
  writeFileSync(cfg, `articles_dir: ${join(dir, 'articles')}\nprogress: false\n`);
  const r = spawnSync('script', ['-qec',
    `WCLIP_CONFIG=${cfg} ${process.execPath} ${CLI} --html ${FIXTURES}ploum-calendar.html ${URL_} -g x -d y`, '/dev/null'],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('\x1b[2K'), 'no live line with progress: false');
});
