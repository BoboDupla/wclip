import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { parseDocument } from 'yaml';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const workflowText = read('.github/workflows/release.yml');
const document = parseDocument(workflowText);
assert.deepEqual(document.errors, []);
const workflow = document.toJS();
const { build, publish, attest } = workflow.jobs;
const steps = Object.values(workflow.jobs).flatMap(job => job.steps);
const files = ['wclip-linux-x64', 'wclip-linux-x64-baseline', 'wclip-linux-arm64', 'wclip-node.js', 'wclip-bun.js'];

test('CI keeps dependency execution read-only and publication push/tag-only', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(build.permissions, { contents: 'read' });
  assert.deepEqual(publish.permissions, { contents: 'write' });
  assert.deepEqual(publish.needs, ['build', 'attest']);
  assert.match(publish.if, /github\.event_name == 'push'/);
  assert.match(publish.if, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(publish.if, /needs\.build\.result == 'success'/);
  assert.match(publish.if, /needs\.attest\.result == 'success'/);
  assert.match(publish.if, /needs\.attest\.result == 'skipped'/);
  assert.ok(!('pull_request_target' in workflow.on));
  for (const job of [publish, attest]) {
    assert.ok(job.steps.every(s => !s.uses?.startsWith('actions/checkout@')));
    for (const s of job.steps) {
      assert.doesNotMatch(s.run ?? '', /\b(?:npm|npx|node|bun|wclip|python3?)\s+(?:run|ci|install|exec|\.\/|build\/)/);
    }
  }
  for (const s of steps.filter(s => s.uses?.startsWith('actions/checkout@'))) {
    assert.equal(s.with['persist-credentials'], false);
  }
  for (const s of steps) assert.doesNotMatch(s.run ?? '', /\$\{\{/);
});

test('CI installs without lifecycle scripts and wires the native Bun ahead of its npm stub', () => {
  const install = build.steps.find(s => s.name === 'Install locked dependencies without lifecycle scripts');
  assert.match(install.run, /^npm ci --ignore-scripts/);
  const expose = build.steps.find(s => s.name === 'Expose the lockfile-installed Bun binary');
  assert.match(expose.run, /ln -sfn \.\.\/@oven\/bun-linux-x64\/bin\/bun node_modules\/\.bin\/bun/);
  assert.doesNotMatch(expose.run, /node install\.js|npm rebuild/);
  const audit = build.steps.find(s => s.name === 'Audit production and bootstrap tooling dependencies');
  assert.match(audit.run, /npm audit --omit=dev --audit-level=moderate/);
  assert.match(audit.run, /npm audit --prefix tooling --audit-level=high/);
});

test('the tag-triggered release build does not restore an npm cache', () => {
  const setup = build.steps.find(s => s.uses?.startsWith('actions/setup-node@'));
  // A poisoned cache could substitute dependencies into a published release.
  assert.equal(setup.with.cache, undefined);
});

test('actions use immutable full commit pins with version comments', () => {
  for (const s of steps.filter(s => s.uses)) assert.match(s.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  const usesLines = workflowText.split('\n').filter(line => /\buses:/.test(line));
  for (const line of usesLines) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/);
});

test('release preserves all runtime formats, checksums and prerelease handling', () => {
  const upload = build.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const f of [...files, 'SHA256SUMS']) assert.ok(upload.with.path.split('\n').includes(`build/${f}`));
  for (const job of [publish, attest]) {
    const download = job.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with['artifact-ids'], '${{ needs.build.outputs.artifact-id }}');
    assert.equal(download.with['merge-multiple'], true);
    assert.ok(job.steps.some(s => s.run?.includes('sha256sum --strict --check SHA256SUMS')));
  }
  const release = publish.steps.find(s => s.name === 'Publish the release');
  assert.equal(release.env.GH_REPO, '${{ github.repository }}');
  assert.match(release.run, /--verify-tag/);
  assert.match(release.run, /\*-\*\) pre=\(--prerelease\)/);
  for (const f of [...files, 'SHA256SUMS']) assert.ok(release.run.includes(f));
  assert.match(attest.if, /github\.event\.repository\.private == false/);
  assert.deepEqual(attest.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
});

test('version guard executes and rejects either stale lock root, source or tag', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wclip-ci-versions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'));
  const snippet = build.steps.find(s => s.name === 'Check source, manifest, lockfile and tag versions').run;
  const code = snippet.slice(snippet.indexOf('\n') + 1).replace(/\nNODE\s*$/, '\n');
  function run({ pkg = '1.2.3', lock = pkg, lockRoot = pkg, src = pkg, tag, type = tag ? 'tag' : 'branch' } = {}) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: pkg }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ version: lock, packages: { '': { version: lockRoot } } }));
    writeFileSync(join(dir, 'src/fetch.ts'), `export const VERSION = '${src}';\n`);
    return spawnSync(process.execPath, ['--input-type=module'], {
      cwd: dir, input: code, encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: tag ?? 'main' },
    });
  }
  for (const options of [{}, { tag: 'v1.2.3' }, { pkg: '1.2.3-rc1', tag: 'v1.2.3-rc1' }]) {
    const result = run(options); assert.equal(result.status, 0, result.stderr);
  }
  for (const options of [
    { lock: '1.2.2' }, { lockRoot: '1.2.2' }, { src: '1.2.2' },
    { tag: 'v1.2.2' }, { tag: 'vgarbage' }, { tag: '1.2.3' },
  ]) {
    const result = run(options); assert.notEqual(result.status, 0, JSON.stringify(options));
  }
});

test('source launcher requires Node 22.12+, uses both locks and suppresses lifecycle hooks', () => {
  const launcher = read('wclip');
  const guard = launcher.match(/node -e '([\s\S]+?)'; then/)?.[1];
  assert.ok(guard);
  for (const [node, expected] of [['20.19.0', 1], ['22.0.0', 1], ['22.11.0', 1], ['22.12.0', 0], ['22.99.0', 0], ['24.0.0', 0], ['26.7.0', 0]]) {
    let status;
    vm.runInNewContext(guard, { process: { versions: { node }, exit(code) { status = code; } } });
    assert.equal(status, expected, node);
  }
  assert.match(launcher, /npm ci --omit=dev --ignore-scripts/);
  assert.match(launcher, /npm ci --prefix tooling --ignore-scripts/);
  assert.match(launcher, /--typeRoots tooling\/node_modules\/@types/);
  assert.doesNotMatch(launcher, /npm install|--no-package-lock|\.tools\//);
  const pkg = JSON.parse(read('tooling/package.json'));
  const lock = JSON.parse(read('tooling/package-lock.json'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@types/node', '@types/sanitize-html', 'typescript']);
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
    assert.ok(!entry.hasInstallScript, path);
  }
});

test('binary smoke never hides a failed browser CLI behind matching stdout', t => {
  const dir = mkdtempSync(join(tmpdir(), 'wclip-ci-smoke-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake-cli.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--html') {
  if (args.includes('--stdout')) {
    process.stdout.write('---\\ntitle: fixture\\n---\\n\\n' + readFileSync('golden/' + basename(args[1], '.html') + '.md', 'utf8') + '\\n');
  } else {
    const base = readFileSync(process.env.WCLIP_CONFIG, 'utf8').trim().slice('articles_dir: '.length);
    for (const path of ['html/how-i-fell-in-love-with-calendartxt.html', 'epub/how-i-fell-in-love-with-calendartxt.epub']) {
      const file = join(base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'test canary');
    }
  }
} else {
  if (!args.includes('--allow-private') || !args.includes('--browser')) process.exit(19);
  process.stdout.write('only exists after JavaScript\\n');
  process.exit(17);
}
`);
  chmodSync(fake, 0o755);
  const result = spawnSync('sh', [new URL('test/binary-smoke.sh', root).pathname, fake], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: dir, WCLIP_CHROMIUM: '/unused-test-canary' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /ok   html\//);
  assert.match(result.stdout, /ok   epub\//);
  assert.match(result.stdout, /FAIL headless browser CLI exited nonzero/);
  assert.doesNotMatch(result.stdout, /FAIL .*golden Markdown/);
});

test('Dependabot covers both npm locks and action SHA upgrades', () => {
  const config = parseDocument(read('.github/dependabot.yml')).toJS();
  assert.deepEqual(config.updates.map(u => [u['package-ecosystem'], u.directory]), [
    ['npm', '/'], ['npm', '/tooling'], ['github-actions', '/'],
  ]);
});
