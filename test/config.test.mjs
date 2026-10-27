// Where the config is read from, and the $WCLIP_* overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
const clear = { WCLIP_CONFIG: undefined, WCLIP_CHROMIUM: undefined };

test('config defaults to ~/.config/wclip/config.yaml', () => {
  const home = mkdtempSync(join(tmpdir(), 'wclip-home-'));
  withEnv({ ...clear, HOME: home }, () =>
    assert.equal(configPath(), join(home, '.config', 'wclip', 'config.yaml')));
});

test('$WCLIP_CONFIG overrides the default path', () => {
  withEnv({ WCLIP_CONFIG: '/somewhere/else.yaml' }, () => {
    assert.equal(configPath(), '/somewhere/else.yaml');
    assert.equal(envVar('CONFIG'), '/somewhere/else.yaml');
  });
});

test('$WCLIP_CHROMIUM is read for the browser fallback', () => {
  withEnv({ WCLIP_CHROMIUM: '/usr/bin/x' }, () => assert.equal(envVar('CHROMIUM'), '/usr/bin/x'));
});
