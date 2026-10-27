import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { get, fetchPage, HONEST_UA, BROWSER_UA, DEFAULT_MAX_BYTES, DEFAULT_MAX_DECODED_BYTES } from '../dist/fetch.js';
import { checkedUrl, guardedLookup, isPublicAddress, checkBrowserTarget } from '../dist/network-policy.js';
import { FIXTURES } from './helpers.mjs';

const privatePolicy = { allowPrivate: true };
const cert = readFileSync(`${FIXTURES}tls-test.crt`);
const key = readFileSync(`${FIXTURES}tls-test.key`);
const body = Buffer.from('<html><body>bounded body</body></html>');
let server, secureServer, base, secureBase, hits = 0, streamClosed = false;
const timers = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  server = createServer((req, res) => {
    hits++;
    const send = (payload, headers = {}) => { res.writeHead(200, { 'content-type': 'text/html', ...headers }); res.end(payload); };
    if (req.url === '/ok') return send(body);
    if (req.url === '/ua') return send(req.headers['user-agent']);
    if (req.url === '/length') { res.writeHead(200, { 'content-length': '1000000' }); res.flushHeaders(); return; }
    if (req.url === '/stream') {
      streamClosed = false;
      res.writeHead(200, { 'content-type': 'text/html' });
      const timer = setInterval(() => res.write(Buffer.alloc(512, 'x')), 5);
      timers.add(timer);
      res.on('close', () => { streamClosed = true; clearInterval(timer); timers.delete(timer); });
      return;
    }
    if (req.url === '/bomb') return send(gzipSync(Buffer.alloc(1000000, 'a')), { 'content-encoding': 'gzip' });
    if (req.url === '/stack') return send(brotliCompressSync(gzipSync(body)), { 'content-encoding': 'gzip, br' });
    if (req.url === '/deflate') return send(deflateSync(body), { 'content-encoding': 'deflate' });
    if (req.url === '/stack-bomb') return send(brotliCompressSync(gzipSync(Buffer.alloc(1000000, 'a'))), { 'content-encoding': 'gzip, br' });
    if (req.url === '/intermediate-bomb') {
      // A valid gzip stream with a very large optional filename expands the outer
      // brotli layer before gunzip would emit the tiny final body.
      const gz = gzipSync(body);
      const largeHeader = Buffer.concat([Buffer.from(gz.subarray(0, 10)), Buffer.alloc(50000, 'x'), Buffer.from([0]), gz.subarray(10)]);
      largeHeader[3] |= 8;
      return send(brotliCompressSync(largeHeader), { 'content-encoding': 'gzip, br' });
    }
    if (req.url === '/unknown') return send(body, { 'content-encoding': 'made-up' });
    if (req.url === '/layers') return send(body, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip' });
    if (req.url === '/truncated') { res.writeHead(200, { 'content-length': '500' }); res.end('short'); return; }
    if (req.url === '/bad-gzip') return send('not a gzip', { 'content-encoding': 'gzip' });
    if (req.url === '/silent') return;
    if (req.url === '/trickle') {
      res.writeHead(200);
      const timer = setInterval(() => res.write('x'), 10);
      timers.add(timer);
      res.on('close', () => { clearInterval(timer); timers.delete(timer); });
      return;
    }
    if (req.url?.startsWith('/slow-redirect')) {
      const timer = setTimeout(() => { timers.delete(timer); res.writeHead(302, { location: '/slow-redirect' }); res.end(); }, 70);
      timers.add(timer);
      res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
      return;
    }
    const redirects = {
      '/redirect': '/ok', '/invalid-redirect': 'http://[', '/credentials': 'http://name:secret@example.org/',
      '/scheme': 'file:///etc/passwd', '/empty-credentials': 'http://@example.org/', '/loop': '/loop',
    };
    if (Object.hasOwn(redirects, req.url)) { res.writeHead(302, { location: redirects[req.url] }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  secureServer = createHttpsServer({ key, cert }, (_req, res) => { res.writeHead(302, { location: `${base}/ok` }); res.end(); });
  await new Promise(resolve => secureServer.listen(0, '127.0.0.1', resolve));
  secureBase = `https://127.0.0.1:${secureServer.address().port}`;
});
after(async () => {
  for (const timer of timers) clearInterval(timer);
  server.closeAllConnections(); secureServer.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => secureServer.close(resolve))]);
});
const localGet = (path, policy = {}, timeout = 2) => get(`${base}${path}`, {}, timeout, {}, { ...privatePolicy, ...policy });

test('default byte limits are both 20 MiB', () => {
  assert.equal(DEFAULT_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_DECODED_BYTES, 20 * 1024 * 1024);
});

test('non-public IPv4/IPv6, transition and metadata addresses are rejected', () => {
  const denied = ['0.0.0.0', '0.12.13.14', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.169.254', '169.254.170.2', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1',
    '192.168.1.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '168.63.129.16',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:0a00:0001', '::ffff:169.254.169.254', '::127.0.0.1',
    'fd00:ec2::254', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', 'fec0::1',
    '64:ff9b::a00:1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1'];
  for (const address of denied) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255',
    '172.32.0.0', '192.169.0.1', '198.20.0.1', '223.255.255.255', '2001:4860:4860::8888',
    '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(address), true, address);
});

test('URL canonicalization cannot bypass local/private IP blocking', async () => {
  const denied = ['127.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.0.1', '0x7f.1',
    '0x0a000001', '0300.0250.0.1', '[::1]', '[::ffff:7f00:1]', '[::ffff:192.168.1.1]', 'localhost', 'x.localhost.'];
  const beforeHits = hits;
  for (const host of denied) await assert.rejects(get(`http://${host}:${server.address().port}/ok`, {}, 0.5), /blocked non-public/);
  assert.equal(hits, beforeHits);
});

test('real IPv6 loopback server is blocked by default and usable only with opt-in', async t => {
  const ipv6 = createServer((_req, res) => res.end('IPv6 works'));
  try {
    await new Promise((resolve, reject) => { ipv6.once('error', reject); ipv6.listen(0, '::1', resolve); });
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) { t.skip('IPv6 loopback unavailable'); return; }
    throw error;
  }
  try {
    const url = `http://[::1]:${ipv6.address().port}/`;
    await assert.rejects(get(url, {}, 1), /blocked non-public/);
    assert.equal((await get(url, {}, 1, {}, privatePolicy)).body.toString(), 'IPv6 works');
  } finally { ipv6.closeAllConnections(); await new Promise(resolve => ipv6.close(resolve)); }
});

test('private access must be explicitly opted into; fetchPage retains its fifth policy argument', async () => {
  await assert.rejects(get(`${base}/ok`, {}, 1), /blocked non-public/);
  assert.equal(await fetchPage(`${base}/ok`, HONEST_UA, 1), null);
  assert.equal((await fetchPage(`${base}/ok`, HONEST_UA, 1, {}, privatePolicy))?.html, body.toString());
});

test('URL credentials and non-HTTP schemes are rejected even with allowPrivate', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.org/', 'data:text/html,test', 'ws://example.org/',
    'http://name:secret@example.org/', 'http://@example.org/']) {
    await assert.rejects(get(url, {}, 1, {}, privatePolicy), /credentials|scheme/);
  }
});

test('redirect policy validates private targets and HTTPS downgrade before connecting', () => {
  const previous = new URL('https://example.org/');
  assert.throws(() => checkedUrl('https://127.1/', {}, previous), /non-public/);
  assert.throws(() => checkedUrl('http://example.org/', privatePolicy, previous), /downgrade/);
  assert.throws(() => checkedUrl('//user:secret@example.org/', {}, previous), /credentials/);
  assert.throws(() => checkedUrl('//@example.org/', {}, previous), /credentials/);
  assert.throws(() => checkedUrl('https:////@example.org/', {}, previous), /credentials/);
});

test('actual HTTPS downgrade is blocked, including when private access is allowed', async () => {
  const beforeHits = hits;
  await assert.rejects(get(secureBase, {}, 1, { ca: cert }, privatePolicy), /HTTPS-to-HTTP/);
  assert.equal(hits, beforeHits, 'downgrade never reaches HTTP server');
});

test('safe redirects work; malformed and disallowed redirect targets reject without escaping async handlers', async () => {
  assert.equal((await localGet('/redirect')).url, `${base}/ok`);
  for (const path of ['/invalid-redirect', '/credentials', '/empty-credentials', '/scheme', '/loop']) {
    await assert.rejects(localGet(path), /invalid HTTP URL|credentials|scheme|too many redirects/);
  }
});

test('DNS lookup checks the exact address handed to the connection on every resolution', async t => {
  let calls = 0;
  t.mock.method(dns, 'lookup', (_host, opts, callback) => {
    assert.equal(opts.all, true);
    calls++;
    callback(null, [{ address: calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
  });
  const lookup = guardedLookup();
  const resolve = () => new Promise((resolve, reject) => lookup('rebind.example', { family: 4, all: false }, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(await resolve(), { address: '8.8.8.8', family: 4 });
  await assert.rejects(resolve(), /blocked non-public.*127\.0\.0\.1/);
  assert.equal(calls, 2);
});

test('real HTTP connection refuses a hostname resolving to a private address', async t => {
  const beforeHits = hits;
  t.mock.method(dns, 'lookup', (_host, _opts, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]));
  await assert.rejects(get(`http://dns-test.example:${server.address().port}/ok`, {}, 1), /blocked non-public/);
  assert.equal(hits, beforeHits);
});

test('actual redirect requests perform fresh guarded lookups rather than reusing a pool', async t => {
  let lookups = 0;
  t.mock.method(dns, 'lookup', (_host, _opts, callback) => {
    lookups++;
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  });
  const response = await get(`http://redirect-dns.example:${server.address().port}/redirect`, {}, 1, {}, privatePolicy);
  assert.deepEqual(response.body, body);
  assert.equal(lookups, 2, 'one actual guarded lookup per redirect hop');
});

test('mixed DNS records and mapped IPv6 records fail closed', async t => {
  t.mock.method(dns, 'lookup', (_host, _opts, callback) => callback(null, [
    { address: '8.8.8.8', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 },
  ]));
  await assert.rejects(new Promise((resolve, reject) => guardedLookup()('mixed.example', { family: 0, all: true }, (error, records) => error ? reject(error) : resolve(records))), /blocked non-public/);
});

test('browser DNS preflight also rejects private answers but does not claim connection pinning', async t => {
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '10.0.0.1', family: 4 }]);
  await assert.rejects(checkBrowserTarget('https://preflight.example/'), /blocked non-public/);
});

test('declared oversized bodies reject before waiting for body data', async () => {
  const started = performance.now();
  await assert.rejects(localGet('/length', { maxBytes: 1024 }), /Content-Length.*1024/);
  assert.ok(performance.now() - started < 1000);
});

test('chunked streaming body is bounded and the remote stream is closed', async () => {
  await assert.rejects(localGet('/stream', { maxBytes: 1024 }), /wire body exceeds 1024/);
  await delay(30);
  assert.equal(streamClosed, true);
});

test('decoded limits also apply to uncompressed responses', async () => {
  await assert.rejects(localGet('/ok', { maxBytes: 4096, maxDecodedBytes: 8 }), /decoded response body exceeds 8/);
});

test('gzip bombs, stacked bombs and intermediate decoding stages are bounded', async () => {
  for (const path of ['/bomb', '/stack-bomb', '/intermediate-bomb']) {
    await assert.rejects(localGet(path, { maxBytes: 4096, maxDecodedBytes: 1024 }), /decoded response body exceeds 1024/);
  }
});

test('gzip/brotli stacks and deflate decode correctly under the limit', async () => {
  assert.deepEqual((await localGet('/stack')).body, body);
  assert.deepEqual((await localGet('/deflate')).body, body);
});

test('unknown/deep/malformed compression and truncated streams reject cleanly', async () => {
  for (const path of ['/unknown', '/layers', '/bad-gzip', '/truncated']) await assert.rejects(localGet(path, {}, 0.5));
});

test('single deadline includes redirect chain, silent sockets and trickling bodies', async () => {
  for (const path of ['/slow-redirect', '/silent', '/trickle']) {
    const started = performance.now();
    await assert.rejects(localGet(path, {}, 0.18), /timed out after 0\.18 s/);
    assert.ok(performance.now() - started < 1200, `${path} must not restart the deadline`);
  }
});

test('timeout includes DNS lookup stalls and settles even without a DNS callback', async t => {
  t.mock.method(dns, 'lookup', () => {});
  await assert.rejects(get('http://stalled-dns.example/', {}, 0.05), /timed out/);
});

test('invalid byte limits and deadlines fail before network activity', async () => {
  for (const maxBytes of [0, -1, Infinity, NaN, 1.5]) await assert.rejects(localGet('/ok', { maxBytes }), /positive safe integer/);
  for (const timeout of [0, -1, Infinity, NaN, 1e12]) await assert.rejects(localGet('/ok', {}, timeout), /timeout must/);
});

test('honest and browser UA headers survive guarded transport unchanged', async () => {
  for (const ua of [HONEST_UA, BROWSER_UA]) {
    assert.equal((await get(`${base}/ua`, { 'User-Agent': ua }, 1, {}, privatePolicy)).body.toString(), ua);
  }
});
