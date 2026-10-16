// The rename from webclip to wclip must not strand existing configs or env vars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath } from '../dist/config.js';
import { envVar } from '../dist/util.js';

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : process.env[k] = v;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v;
  }
}
const noOverride = { WCLIP_CONFIG: undefined, WEBCLIP_CONFIG: undefined };

test('config defaults to ~/.config/wclip/config.yaml', () => {
  const home = mkdtempSync(join(tmpdir(), 'wclip-home-'));
  withEnv({ ...noOverride, HOME: home }, () =>
    assert.equal(configPath(), join(home, '.config', 'wclip', 'config.yaml')));
});

test('an existing ~/.config/webclip/config.yaml is used while the new one is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'wclip-home-'));
  const legacy = join(home, '.config', 'webclip', 'config.yaml');
  mkdirSync(join(home, '.config', 'webclip'), { recursive: true });
  writeFileSync(legacy, 'reading_wpm: 250\n');
  withEnv({ ...noOverride, HOME: home }, () => {
    assert.equal(configPath(), legacy);
    const current = join(home, '.config', 'wclip', 'config.yaml');
    mkdirSync(join(home, '.config', 'wclip'));
    writeFileSync(current, 'reading_wpm: 300\n');
    assert.equal(configPath(), current);
  });
});

test('WCLIP_* env vars win, WEBCLIP_* still work', () => {
  withEnv({ WCLIP_CONFIG: undefined, WEBCLIP_CONFIG: '/old.yaml' }, () => {
    assert.equal(configPath(), '/old.yaml');
    assert.equal(envVar('CONFIG'), '/old.yaml');
  });
  withEnv({ WCLIP_CONFIG: '/new.yaml', WEBCLIP_CONFIG: '/old.yaml' }, () => assert.equal(configPath(), '/new.yaml'));
  withEnv({ WCLIP_CHROMIUM: undefined, WEBCLIP_CHROMIUM: '/usr/bin/x' }, () => assert.equal(envVar('CHROMIUM'), '/usr/bin/x'));
});
