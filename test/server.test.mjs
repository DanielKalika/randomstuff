import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

const movie = {
  id: 258687,
  title: { original: 'Original title', russian: 'Русское название' },
  type: 'Film', year: 2014,
  gallery: { posterUrl: 'https://images.example.test/poster.jpg' },
  synopsis: '<p>A story.</p><p>Another line.</p>',
  rating: { imdb: { value: 8.1 }, kinopoisk: { value: 7.8 } },
  genres: [{ id: 1, name: 'Drama' }], countries: [{ name: 'United States' }],
  duration: '02:14:00',
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data }));
}

async function fixture(t, handler, options = {}) {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    requests.push(url);
    handler(url, res, req);
  });
  const upstreamUrl = await listen(upstream);
  const app = createServer({ upstreamBase: `${upstreamUrl}/api`, ...options });
  const base = await listen(app);
  t.after(async () => { await Promise.all([close(app), close(upstream)]); });
  return { base, requests };
}

test('catalog uses the complete source navigator and normalizes its real movie shape', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => json(res, { items: [movie], total: 72, limit: 30 }));
  const response = await fetch(`${base}/api/catalog?type=films&page=2`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {
    items: [{
      id: '258687', title: 'Original title', originalTitle: 'Original title', russianTitle: 'Русское название',
      year: 2014, type: 'film', poster: 'https://images.example.test/poster.jpg',
      description: 'A story. Another line.', rating: 8.1, genres: ['Drama'],
      countries: ['United States'], runtime: 134,
    }],
    total: 72, page: 2, pageSize: 30,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/api/movies/navigator');
  assert.equal(requests[0].searchParams.get('Films'), 'true');
  assert.equal(requests[0].searchParams.has('Series'), false);
  assert.equal(requests[0].searchParams.get('Page'), '2');
  assert.match(requests[0].searchParams.get('ts'), /^\d{1,4}$/);
  assert.deepEqual([...requests[0].searchParams.keys()].sort(), ['Films', 'Page', 'ts']);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('all catalog titles omit the upstream type filter and cache successful metadata', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => json(res, { items: [movie], total: 1 }));
  await (await fetch(`${base}/api/catalog`)).json();
  await (await fetch(`${base}/api/catalog?type=all&page=1`)).json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/api/movies/navigator');
  assert.equal(requests[0].searchParams.has('Films'), false);
  assert.equal(requests[0].searchParams.has('Series'), false);
  assert.equal(requests[0].searchParams.get('Page'), '1');
  assert.deepEqual([...requests[0].searchParams.keys()].sort(), ['Page', 'ts']);
});

test('series filter and pagination preserve the source navigator limit and reach beyond popular pages', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => json(res, { items: [], total: 300000, limit: 24 }));
  const response = await fetch(`${base}/api/catalog?type=series&page=1001`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], total: 300000, page: 1001, pageSize: 24 });
  assert.equal(requests[0].pathname, '/api/movies/navigator');
  assert.equal(requests[0].searchParams.get('Series'), 'true');
  assert.equal(requests[0].searchParams.has('Films'), false);
  assert.equal(requests[0].searchParams.get('Page'), '1001');
  assert.deepEqual([...requests[0].searchParams.keys()].sort(), ['Page', 'Series', 'ts']);
});

test('search encodes punctuation and Hebrew into one upstream query', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => json(res, { items: [], total: 0 }));
  const query = 'Harry & Potter? / שלום';
  const result = await fetch(`${base}/api/search?${new URLSearchParams({ q: query })}`);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { items: [], total: 0, page: 1, pageSize: 30 });
  assert.equal(requests[0].pathname, '/api/movies/search/');
  assert.equal(requests[0].searchParams.get('query'), query);
  assert.deepEqual([...requests[0].searchParams.keys()].sort(), ['query', 'ts']);
});

test('movie detail falls back to Russian title and Kinopoisk rating, rejecting unsafe poster URLs', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => json(res, {
    movie: { ...movie, title: { original: '', russian: 'Тест' }, type: 'TvSeries',
      rating: { imdb: { value: null }, kinopoisk: { value: 7.2 } },
      gallery: { posterUrl: 'https://user:password@images.example.test/secret' } },
  }));
  const response = await fetch(`${base}/api/movie/258687`);
  const body = await response.json();
  assert.equal(body.movie.title, 'Тест');
  assert.equal(body.movie.type, 'series');
  assert.equal(body.movie.rating, 7.2);
  assert.equal(body.movie.poster, null);
  assert.equal(requests[0].pathname, '/api/movies/258687');
});

test('player returns only the upstream Alloha HTTPS embed, with audio status unverified', async (t) => {
  const iframeUrl = 'https://embed.example.test/movie/abc?existing=value#player';
  const { base, requests } = await fixture(t, (url, res) => json(res, [
    { type: 'Other', iframeUrl: 'https://different.example.test/embed' },
    { type: 'Alloha', iframeUrl: 'javascript:alert(1)' },
    { type: 'Alloha', iframeUrl },
  ]));
  const response = await fetch(`${base}/api/player/258687`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: 'Alloha', iframeUrl, audioSelection: 'unverified' });
  assert.equal(requests[0].pathname, '/api/players');
  assert.equal(requests[0].searchParams.get('kinopoisk'), '258687');
});

test('provider outages are honest, uncached errors and a later request can recover', async (t) => {
  let calls = 0;
  const { base, requests } = await fixture(t, (url, res) => {
    if (++calls === 1) {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end('<html>remote reset</html>');
    } else json(res, { items: [], total: 0 });
  });
  const failed = await fetch(`${base}/api/catalog`);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  const error = await failed.json();
  assert.equal(error.error.code, 'UPSTREAM_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(error), /remote reset/);
  assert.equal((await fetch(`${base}/api/catalog`)).status, 200);
  assert.equal(requests.length, 2);
});

test('invalid provider formats are surfaced without leaking raw responses', async (t) => {
  for (const [name, response] of [
    ['HTML in a successful response', (res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>private upstream output</script>'); }],
    ['malformed JSON', (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{broken'); }],
    ['missing wrapper', (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"items":[]}'); }],
    ['unexpected movie collection', (res) => json(res, { items: {} })],
  ]) await t.test(name, async (sub) => {
    const { base } = await fixture(sub, (url, res) => response(res));
    const result = await fetch(`${base}/api/catalog`);
    assert.equal(result.status, 502);
    const body = await result.json();
    assert.equal(body.error.code, 'UPSTREAM_INVALID_RESPONSE');
    assert.doesNotMatch(JSON.stringify(body), /private upstream output|broken/);
  });
});

test('missing titles and missing or unsafe Alloha embeds return useful 404 responses', async (t) => {
  const { base } = await fixture(t, (url, res) => {
    if (url.pathname.includes('/movies/')) json(res, { movie: null });
    else json(res, [
      { type: 'Alloha', iframeUrl: 'http://insecure.example.test/embed' },
      { type: 'Alloha', iframeUrl: 'https://user:password@embed.example.test/' },
      { type: 'Other', iframeUrl: 'https://embed.example.test/' },
    ]);
  });
  const title = await fetch(`${base}/api/movie/999`);
  assert.equal(title.status, 404);
  assert.equal((await title.json()).error.code, 'NOT_FOUND');
  const player = await fetch(`${base}/api/player/999`);
  assert.equal(player.status, 404);
  assert.equal((await player.json()).error.code, 'PLAYER_NOT_FOUND');
});

test('a slow upstream is aborted with a timeout response', async (t) => {
  const { base } = await fixture(t, () => {}, { timeoutMs: 40 });
  const response = await fetch(`${base}/api/catalog`);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'UPSTREAM_TIMEOUT');
});

test('invalid requests and unsupported methods do not reach the upstream', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => json(res, { items: [] }));
  for (const route of [
    '/api/catalog?page=0', '/api/catalog?page=1.5', '/api/catalog?page=9007199254740992',
    '/api/catalog?type=other', '/api/catalog?page=1&page=2',
    '/api/search?q=x', '/api/search?q=valid&q=duplicate',
    '/api/catalog?url=https://untrusted.example.test', '/api/player/123?url=https://untrusted.example.test',
  ]) assert.equal((await fetch(`${base}${route}`)).status, 400, route);
  assert.equal((await fetch(`${base}/api/proxy`)).status, 404);
  const post = await fetch(`${base}/api/catalog`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  assert.equal(requests.length, 0);
});

test('health reports local readiness without asserting provider availability', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => { res.writeHead(503); res.end(); });
  const response = await fetch(`${base}/api/health`);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'kinopk-companion', upstream: 'unchecked' });
  assert.equal(requests.length, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

function rawRequest(base, rawPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    http.get({ hostname: url.hostname, port: url.port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('static assets and SPA links work while traversal, hidden files, and symlink escapes are blocked', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'movie-server-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir);
  await Promise.all([
    writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Movie companion</title>'),
    writeFile(path.join(publicDir, 'app.js'), 'console.log("app");'),
    writeFile(path.join(directory, 'private.txt'), 'private fixture content'),
    writeFile(path.join(publicDir, '.env'), 'hidden fixture content'),
  ]);
  await symlink(path.join(directory, 'private.txt'), path.join(publicDir, 'escape.txt'));
  const { base } = await fixture(t, (url, res) => json(res, {}), { publicDir });
  const deepLink = await fetch(`${base}/watch/258687`);
  assert.equal(deepLink.status, 200);
  assert.match(await deepLink.text(), /Movie companion/);
  const script = await fetch(`${base}/app.js`);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.match(await script.text(), /console\.log/);
  const head = await fetch(`${base}/app.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/missing.css`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/escape.txt`)).status, 404);
  for (const route of ['/../private.txt', '/%2e%2e/private.txt', '/..%2fprivate.txt', '/%5c..%5cprivate.txt', '/%00', '/%not-valid']) {
    const response = await rawRequest(base, route);
    assert.equal(response.status, 400, route);
    assert.doesNotMatch(response.body, /private fixture content|hidden fixture content/);
  }
});

test('bounded metadata cache evicts old entries', async (t) => {
  const { base, requests } = await fixture(t, (url, res) => json(res, { items: [], total: 0 }), { maxCacheEntries: 1 });
  for (const page of [1, 2, 1]) assert.equal((await fetch(`${base}/api/catalog?page=${page}`)).status, 200);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((url) => url.searchParams.get('ts'))).size, 1);
});
