// The plain fetch's TLS handshake and HTTP handling, against a local HTTPS server.
// Cloudflare answered 403 to Node's fetch() on petapixel.com (2026-10-16) because of how its
// TLS hello looks (it offers ALPN "http/1.1"); the same request without ALPN got the article.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { fetchPage, HONEST_UA } from '../dist/fetch.js';
import { FIXTURES } from './helpers.mjs';

const cert = readFileSync(`${FIXTURES}tls-test.crt`);
const key = readFileSync(`${FIXTURES}tls-test.key`);
const PAGE = `<!doctype html><html><head><title>t</title></head><body>${'<p>Words here.</p>'.repeat(200)}</body></html>`;
let server, base;
let offeredAlpn = [];

before(async () => {
  server = createServer({
    cert, key,
    ALPNCallback: ({ protocols }) => { offeredAlpn.push(protocols); return protocols[0]; },
  }, (req, res) => {
    const html = { 'content-type': 'text/html; charset=utf-8' };
    if (req.url === '/') { res.writeHead(200, html); return res.end(PAGE); }
    if (req.url === '/gzip') { res.writeHead(200, { ...html, 'content-encoding': 'gzip' }); return res.end(gzipSync(PAGE)); }
    if (req.url === '/br') { res.writeHead(200, { ...html, 'content-encoding': 'br' }); return res.end(brotliCompressSync(PAGE)); }
    if (req.url === '/moved') { res.writeHead(301, { location: '/gzip' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF'); }
    res.writeHead(403, html);
    res.end('Sorry, you have been blocked');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path) => fetchPage(`${base}${path}`, HONEST_UA, 5, { ca: cert });

test('the TLS hello offers no ALPN (Cloudflare blocks the one Node fetch() sends)', async () => {
  offeredAlpn = [];
  const p = await get('/');
  assert.equal(p?.html, PAGE);
  assert.deepEqual(offeredAlpn, [], `client offered ALPN ${JSON.stringify(offeredAlpn)}`);
});

test('gzip and brotli bodies are decompressed', async () => {
  assert.equal((await get('/gzip'))?.html, PAGE);
  assert.equal((await get('/br'))?.html, PAGE);
});

test('redirects are followed and the final URL is reported', async () => {
  const p = await get('/moved');
  assert.equal(p?.html, PAGE);
  assert.equal(p?.url, `${base}/gzip`);
});

test('redirect loops, HTTP errors and non-HTML answers give null', async () => {
  assert.equal(await get('/loop'), null);
  assert.equal(await get('/blocked'), null);
  assert.equal(await get('/pdf'), null);
});
