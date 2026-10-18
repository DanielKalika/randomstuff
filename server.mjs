import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://api.kinobox.tv/api';
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
const PAGE_SIZE = 30;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message) => new HttpError(400, 'INVALID_REQUEST', message);
const badUpstream = () => new HttpError(502, 'UPSTREAM_INVALID_RESPONSE',
  'The catalog provider returned an unexpected response. Please try again later.');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 500) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeMovie(movie) {
  if (!isObject(movie) || !/^[1-9]\d{0,14}$/.test(String(movie.id))) throw badUpstream();
  const titles = isObject(movie.title) ? movie.title : {};
  const originalTitle = text(titles.original);
  const russianTitle = text(titles.russian);
  const names = (list) => Array.isArray(list)
    ? list.map((item) => text(typeof item === 'string' ? item : item?.name, 128)).filter(Boolean).slice(0, 30)
    : [];
  const ratingValue = (value) => typeof value === 'number' && value > 0 && value <= 10 ? value : null;
  let runtime = null;
  if (typeof movie.duration === 'string' && /^\d{1,3}:\d{2}:\d{2}$/.test(movie.duration)) {
    const [hours, minutes, seconds] = movie.duration.split(':').map(Number);
    if (minutes < 60 && seconds < 60) runtime = hours * 60 + minutes + (seconds >= 30 ? 1 : 0);
  } else if (typeof movie.runtime === 'number' && Number.isFinite(movie.runtime)) {
    runtime = Math.round(movie.runtime);
  }
  if (!runtime || runtime < 1 || runtime > 6000) runtime = null;
  return {
    id: String(movie.id),
    title: originalTitle || russianTitle || 'Untitled',
    originalTitle,
    russianTitle,
    year: Number.isInteger(movie.year) && movie.year > 1800 && movie.year < 2300 ? movie.year : null,
    type: String(movie.type).toLowerCase() === 'film' ? 'film' : 'series',
    poster: httpsUrl(movie.gallery?.posterUrl),
    description: text(movie.synopsis, 20000).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    rating: ratingValue(movie.rating?.imdb?.value) ?? ratingValue(movie.rating?.kinopoisk?.value),
    genres: names(movie.genres),
    countries: names(movie.countries),
    runtime,
  };
}

function parameter(params, name, fallback) {
  const values = params.getAll(name);
  if (values.length > 1) throw invalid(`Provide ${name} only once.`);
  return values.length ? values[0] : fallback;
}

function integerParameter(value, name, max) {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw invalid(`${name} must be a positive integer up to ${max}.`);
  return Number(value);
}

function assertParameters(params, names) {
  for (const key of params.keys()) if (!names.includes(key)) throw invalid(`Unsupported parameter: ${key}.`);
}

function sendJson(res, status, payload, maxAge = 0) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status < 400 && maxAge ? `public, max-age=${maxAge}` : 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJson(response) {
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) throw badUpstream();
  const size = Number(response.headers.get('content-length'));
  if (size > MAX_UPSTREAM_BYTES) {
    await response.body?.cancel();
    throw badUpstream();
  }
  if (!response.body) throw badUpstream();
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BYTES) {
        await reader.cancel();
        throw badUpstream();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badUpstream();
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/** The configurable upstream is for trusted server setup/tests, never an HTTP parameter. */
export function createServer({
  fetchImpl = globalThis.fetch,
  upstreamBase = API_BASE,
  publicDir = path.join(ROOT, 'public'),
  timeoutMs = 12000,
  cacheTtlMs = 60000,
  maxCacheEntries = 100,
} = {}) {
  const cache = new Map();
  const base = new URL(`${upstreamBase.replace(/\/$/, '')}/`);
  const staticRoot = path.resolve(publicDir);
  const sessionId = randomInt(10000);

  async function upstream(resource, search = {}) {
    const url = new URL(resource, base);
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
    // The source site sends a per-session cache key too; this is never a credential.
    url.searchParams.set('ts', sessionId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new HttpError(404, 'NOT_FOUND', 'This title is not available from the catalog provider.');
        throw new HttpError(503, 'UPSTREAM_UNAVAILABLE',
          'The catalog provider is unavailable right now. Please try again shortly, or open the original site.');
      }
      const payload = await readJson(response);
      if (!isObject(payload) || !Object.hasOwn(payload, 'data')) throw badUpstream();
      return payload.data;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) throw new HttpError(504, 'UPSTREAM_TIMEOUT',
        'The catalog provider took too long to respond. Please try again.');
      throw new HttpError(503, 'UPSTREAM_UNAVAILABLE',
        'The catalog provider could not be reached. Please try again shortly, or open the original site.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function cached(key, load, ttl = cacheTtlMs) {
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.payload;
    cache.delete(key);
    const payload = await load();
    if (ttl > 0 && maxCacheEntries > 0) {
      for (const [oldKey, oldEntry] of cache) if (oldEntry.expires <= Date.now()) cache.delete(oldKey);
      while (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { payload, expires: Date.now() + ttl });
    }
    return payload;
  }

  function normalizeList(data, page) {
    if (!isObject(data) || !Array.isArray(data.items) || data.items.length > 1000) throw badUpstream();
    return {
      items: data.items.map(normalizeMovie),
      total: Number.isInteger(data.total) && data.total >= 0 ? data.total : data.items.length,
      page,
      pageSize: Number.isInteger(data.limit) && data.limit > 0 && data.limit <= 1000 ? data.limit : PAGE_SIZE,
    };
  }

  async function api(url, res) {
    if (url.pathname === '/api/health') {
      assertParameters(url.searchParams, []);
      sendJson(res, 200, { status: 'ok', service: 'kinopk-companion', upstream: 'unchecked' });
      return;
    }
    if (url.pathname === '/api/catalog') {
      assertParameters(url.searchParams, ['type', 'page']);
      const type = parameter(url.searchParams, 'type', 'all');
      if (!['all', 'films', 'series'].includes(type)) throw invalid('type must be all, films, or series.');
      const page = integerParameter(parameter(url.searchParams, 'page', '1'), 'page', Number.MAX_SAFE_INTEGER);
      const payload = await cached(`catalog:${type}:${page}`, async () => normalizeList(
        await upstream('movies/navigator', {
          ...(type === 'films' ? { Films: 'true' } : type === 'series' ? { Series: 'true' } : {}),
          Page: page,
        }), page));
      sendJson(res, 200, payload, 30);
      return;
    }
    if (url.pathname === '/api/search') {
      assertParameters(url.searchParams, ['q']);
      const query = parameter(url.searchParams, 'q', '').trim();
      if (query.length < 2 || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) throw invalid('Search for a title using 2 to 200 characters.');
      const payload = await cached(`search:${query}`, async () => normalizeList(
        await upstream('movies/search/', { query }), 1));
      sendJson(res, 200, payload, 30);
      return;
    }
    const route = url.pathname.match(/^\/api\/(movie|player)\/([1-9]\d{0,14})$/);
    if (route) {
      assertParameters(url.searchParams, []);
      const [, kind, id] = route;
      const payload = await cached(`${kind}:${id}`, async () => {
        if (kind === 'movie') {
          const data = await upstream(`movies/${id}`);
          if (!isObject(data)) throw badUpstream();
          if (data.movie === null) throw new HttpError(404, 'NOT_FOUND', 'This title is not available from the catalog provider.');
          return { movie: normalizeMovie(data.movie) };
        }
        const data = await upstream('players', { kinopoisk: id });
        if (!Array.isArray(data)) throw badUpstream();
        for (const player of data) {
          if (isObject(player) && String(player.type).toLowerCase() === 'alloha') {
            const iframeUrl = httpsUrl(player.iframeUrl);
            if (iframeUrl) return { provider: 'Alloha', iframeUrl, audioSelection: 'unverified' };
          }
        }
        throw new HttpError(404, 'PLAYER_NOT_FOUND',
          'An Alloha player is not available for this title. You can check the original site.');
      }, kind === 'player' ? Math.min(cacheTtlMs, 30000) : cacheTtlMs);
      sendJson(res, 200, payload, kind === 'player' ? 15 : 30);
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', 'This API endpoint does not exist.');
  }

  async function serveStatic(url, res, method) {
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.split('/').some((segment) => segment.startsWith('.'))) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
    let candidate = path.resolve(staticRoot, `.${pathname}`);
    if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) throw invalid('Invalid file path.');
    if (pathname === '/' || !path.extname(pathname)) candidate = path.join(staticRoot, 'index.html');
    try {
      const [resolvedRoot, resolvedFile] = await Promise.all([realpath(staticRoot), realpath(candidate)]);
      if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
      const info = await stat(resolvedFile);
      if (!info.isFile()) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
      const body = method === 'HEAD' ? null : await readFile(resolvedFile);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(resolvedFile).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': path.extname(resolvedFile) === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(body);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) throw new HttpError(404, 'NOT_FOUND', 'File not found.');
      throw error;
    }
  }

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      if (req.url.length > 8192) throw new HttpError(414, 'INVALID_REQUEST', 'The request URL is too long.');
      const rawPath = req.url.split('?')[0];
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch { throw invalid('Invalid URL encoding.'); }
      if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').includes('..')) throw invalid('Invalid file path.');
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(req.method) || (req.method === 'HEAD' && url.pathname.startsWith('/api/'))) {
        res.setHeader('Allow', url.pathname.startsWith('/api/') ? 'GET' : 'GET, HEAD');
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This request method is not supported.');
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') await api(url, res);
      else await serveStatic(url, res, req.method);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, error instanceof HttpError ? error.status : 500, {
        error: {
          code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof HttpError ? error.message : 'The server could not complete this request.',
        },
      });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  createServer().listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Movie companion is running on port ${port}.`);
  });
}
