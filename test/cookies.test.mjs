// Cookie files: parsing, host/path/secure scoping and the per-hop header rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookieJar, loadCookieJar, parseCookieFile, MAX_COOKIES } from '../dist/cookies.js';

const NETSCAPE = [
  '# Netscape HTTP Cookie File',
  '# https://curl.se/docs/http-cookies.html',
  '',
  '.wsj.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tSECRET1',
  'www.wsj.com\tFALSE\t/tech\tFALSE\t0\tjob\treporter',
  '#HttpOnly_wsj.com\tTRUE\t/\tTRUE\t1893456000\thttpOnlyOne\tyes',
  'other.example\tFALSE\t/\tFALSE\t0\tforeign\tnope',
  'broken line without tabs',
].join('\n');

test('Netscape files: comments skipped, HttpOnly lines kept, fields parsed', () => {
  const cookies = parseCookieFile(NETSCAPE);
  assert.deepEqual(cookies.map(c => c.name).sort(), ['httpOnlyOne', 'job', 'sessionid', 'foreign'].sort());
  const session = cookies.find(c => c.name === 'sessionid');
  assert.equal(session.domain, 'wsj.com');
  assert.equal(session.secure, true);
  assert.equal(session.hostOnly, false);
  assert.equal(session.expires, 1893456000);
  const job = cookies.find(c => c.name === 'job');
  assert.equal(job.hostOnly, true);
  assert.equal(job.path, '/tech');
  assert.equal(job.expires, 0);
});

test('a cookie is only sent to its own host, subdomains only when the file says so', () => {
  const jar = cookieJar(parseCookieFile(NETSCAPE));
  assert.equal(jar.header('https://wsj.com/tech/x'), 'sessionid=SECRET1; httpOnlyOne=yes');
  assert.equal(jar.header('https://www.wsj.com/tech/x'), 'job=reporter; sessionid=SECRET1; httpOnlyOne=yes');
  // hostOnly=TRUE on www.wsj.com must not leak to a sibling subdomain
  assert.doesNotMatch(jar.header('https://edition.wsj.com/tech/x') ?? '', /job=/);
  assert.equal(jar.header('https://other.example/'), 'foreign=nope');
  assert.equal(jar.header('https://notwsj.com/'), null);
  assert.equal(jar.header('https://wsj.com.evil.example/'), null);
});

test('secure and path rules are applied to the request', () => {
  const jar = cookieJar(parseCookieFile(NETSCAPE));
  assert.equal(jar.header('http://wsj.com/tech/x'), null, 'Secure cookies are withheld over plain HTTP');
  assert.equal(jar.header('http://www.wsj.com/tech/x'), 'job=reporter', 'only the non-Secure cookie survives plain HTTP');
  assert.equal(jar.header('https://wsj.com/tech/x'), 'sessionid=SECRET1; httpOnlyOne=yes');
  assert.equal(jar.header('https://www.wsj.com/other'), 'sessionid=SECRET1; httpOnlyOne=yes', '/tech must not match /other');
  assert.equal(jar.header('https://www.wsj.com/technology'), 'sessionid=SECRET1; httpOnlyOne=yes', '/tech must not match /technology');
});

test('expired cookies are dropped, session cookies are kept', () => {
  const text = ['a.example\tFALSE\t/\tFALSE\t1\tgone\t1', 'a.example\tFALSE\t/\tFALSE\t0\there\t2'].join('\n');
  const jar = cookieJar(parseCookieFile(text));
  assert.equal(jar.header('https://a.example/'), 'here=2');
});

test('bare name=value lines apply to any host', () => {
  const jar = cookieJar(parseCookieFile('token=abc123\n# comment\nname with spaces=no'));
  assert.equal(jar.count, 1);
  assert.equal(jar.header('https://anything.example/'), 'token=abc123');
});

test('header-breaking values and names are rejected', () => {
  const text = [
    'x.example\tFALSE\t/\tFALSE\t0\tok\tfine',
    'x.example\tFALSE\t/\tFALSE\t0\tbad=X\tvalue',            // '=' in the name
    'x.example\tFALSE\t/\tFALSE\t0\tsemi\ta;b',               // ';' in the value
    'x.example\tFALSE\t/\tFALSE\t0\tnewline\ta\rb',
    'x.example\tFALSE\t/\tFALSE\t0\thuge\t' + 'v'.repeat(5000),
  ].join('\n');
  const jar = cookieJar(parseCookieFile(text));
  assert.deepEqual(parseCookieFile(text).map(c => c.name), ['ok']);
  assert.equal(jar.header('https://x.example/'), 'ok=fine');
});

test('duplicate name/domain/path keeps the last entry, longest path comes first', () => {
  const text = [
    'd.example\tFALSE\t/\tFALSE\t0\tdup\tfirst',
    'd.example\tFALSE\t/\tFALSE\t0\tdup\tsecond',
    'd.example\tFALSE\t/deep\tFALSE\t0\tspecific\t1',
  ].join('\n');
  const jar = cookieJar(parseCookieFile(text));
  assert.equal(jar.header('https://d.example/'), 'dup=second');
  assert.equal(jar.header('https://d.example/deep/x'), 'specific=1; dup=second');
});

test('the cookie count is capped', () => {
  const many = Array.from({ length: MAX_COOKIES + 50 }, (_, i) => `c.example\tFALSE\t/\tFALSE\t0\tc${i}\tv`).join('\n');
  assert.equal(cookieJar(parseCookieFile(many)).count, MAX_COOKIES);
});

test('loadCookieJar reads a file and refuses a missing one without leaking contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wclip-cookies-'));
  const p = join(dir, 'cookies.txt');
  writeFileSync(p, NETSCAPE);
  assert.equal(loadCookieJar(p).count, 4);
  assert.throws(() => loadCookieJar(join(dir, 'nope.txt')), /ENOENT|could not|no such file/i);
});
