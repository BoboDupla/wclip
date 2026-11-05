// Credentials belong to the origin they were meant for. A redirect that leaves the
// original origin must not receive our Authorization header.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { get } from '../dist/fetch.js';

let a, b, aBase, bBase;
const seen = [];

const page = '<html><head><title>t</title></head><body><p>ok</p></body></html>';

before(async () => {
  b = createServer((req, res) => {
    seen.push(['b', req.headers.authorization ?? null, req.headers['proxy-authorization'] ?? null]);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise(r => b.listen(0, '127.0.0.1', r));
  bBase = `http://127.0.0.1:${b.address().port}`;

  a = createServer((req, res) => {
    if (req.url === '/same') {
      res.writeHead(302, { location: '/final' });
      return res.end();
    }
    if (req.url === '/cross') {
      res.writeHead(302, { location: bBase + '/final' });
      return res.end();
    }
    if (req.url === '/final') {
      seen.push(['a', req.headers.authorization ?? null, req.headers['proxy-authorization'] ?? null]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => a.listen(0, '127.0.0.1', r));
  aBase = `http://127.0.0.1:${a.address().port}`;
});

after(() => {
  a?.close();
  b?.close();
});

const policy = { allowPrivate: true };

test('a same-origin redirect keeps Authorization', async () => {
  seen.length = 0;
  const r = await get(`${aBase}/same`, { Authorization: 'Bearer for-a' }, 5, {}, policy);
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [['a', 'Bearer for-a', null]]);
});

test('a cross-origin redirect drops Authorization and Proxy-Authorization', async () => {
  seen.length = 0;
  const r = await get(`${aBase}/cross`,
    { Authorization: 'Bearer for-a', 'Proxy-Authorization': 'Basic cHJveHk=' }, 5, {}, policy);
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [['b', null, null]]);
});

test('a cross-origin redirect keeps ordinary headers', async () => {
  seen.length = 0;
  await get(`${aBase}/cross`, { 'User-Agent': 'wclip-test', Accept: 'text/html' }, 5, {}, policy);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], null);
});
