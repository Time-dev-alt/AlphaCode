/**
 * The npm edge — one Pages Function, no extra Worker.
 *
 *   GET  /api/npm/pkg/<name>              slim, abbreviated packument
 *   GET  /api/npm/tar/<name>/-/<file>     tarball passthrough (immutable)
 *   POST /api/npm/resolve                 { dependencies } → flat install plan
 *   GET  /api/npm/health                  what is configured
 *
 * Why this exists: a browser cannot talk to `registry.npmjs.org` reliably (no
 * CORS on some paths, slow cold packuments, and every client resolving the same
 * tree from scratch). Doing resolution once at the edge and caching the result
 * in KV turns "install" into a single request for every subsequent user.
 *
 * Efficiencies, in order of impact:
 *   1. abbreviated packuments (`application/vnd.npm.install-v1+json`) — 5–10×
 *      smaller than the full document;
 *   2. `caches.default` for packuments (5 min) and tarballs (1 year);
 *   3. KV for *resolved plans* (30 days) — the expensive part is the graph walk,
 *      not the bytes, so we cache the answer and not just the inputs;
 *   4. parallel packument fetches (8 at a time) inside the resolver;
 *   5. `waitUntil` on every cache write, so no user waits for a cache fill.
 *
 * Binding: `NPM_CACHE` (KV namespace, optional). Without it the function still
 * works — it is just per-colo instead of global.
 */
import { resolveGraph, fetchPackument, planKey, slimPackument } from './_resolver.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

/** Only serve the app itself: a public proxy is a abuse magnet. */
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // curl / tests / server-to-server
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

const scratch = () => (typeof caches !== 'undefined' ? caches.default : null);

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/npm\/?/, '');
  const method = request.method.toUpperCase();

  if (path === 'health') {
    return json({
      ok: true,
      proxy: true,
      kv: Boolean(env.NPM_CACHE),
      registry: 'https://registry.npmjs.org',
      features: ['packument', 'tarball', 'resolve', 'plan-cache'],
    });
  }

  if (!sameOrigin(request)) {
    return json({ error: 'cross-origin requests are not allowed' }, 403);
  }

  const cache = scratch();

  // ---- POST /resolve -------------------------------------------------------
  if (path === 'resolve') {
    if (method !== 'POST') return json({ error: 'POST a JSON body: {"dependencies":{...}}' }, 405);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }
    const deps = body?.dependencies;
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
      return json({ error: 'expected {"dependencies":{"lodash":"^4.17.0"}}' }, 400);
    }
    if (Object.keys(deps).length > 40) return json({ error: 'too many direct dependencies (max 40)' }, 400);

    const key = `plan:${await planKey(deps)}`;
    if (env.NPM_CACHE) {
      const hit = await env.NPM_CACHE.get(key, { type: 'json' }).catch(() => null);
      if (hit) return json({ ...hit, cached: true }, 200, { 'Cache-Control': 'public, max-age=300', 'X-Plan-Cache': 'hit' });
    }

    let plan;
    try {
      plan = await resolveGraph(deps, { cache });
    } catch (err) {
      return json({ error: `resolution failed: ${err.message}` }, 502);
    }
    plan.cached = false;

    if (env.NPM_CACHE) {
      const write = env.NPM_CACHE.put(key, JSON.stringify(plan), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
      if (context.waitUntil) context.waitUntil(write);
    }
    return json(plan, 200, { 'Cache-Control': 'public, max-age=300', 'X-Plan-Cache': 'miss' });
  }

  // ---- GET /pkg/<name> -----------------------------------------------------
  if (path.startsWith('pkg/')) {
    const name = decodeURIComponent(path.slice(4)).replace(/^\/+|\/+$/g, '');
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return json({ error: 'invalid package name' }, 400);

    const cacheKey = new Request(`https://npm-cache.internal/pkg/${name}`);
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return new Response(hit.body, { headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=300', 'X-Packument-Cache': 'hit' } });
    }
    let packument;
    try {
      packument = await fetchPackument(name, { cache });
    } catch (err) {
      return json({ error: err.message }, err.message.includes('does not exist') ? 404 : 502);
    }
    const slim = slimPackument(packument) || packument;
    const response = json(slim, 200, { 'Cache-Control': 'public, max-age=300' });
    if (cache && response.ok) {
      const copy = new Response(JSON.stringify(slim), { headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=300' } });
      const write = cache.put(cacheKey, copy).catch(() => {});
      if (context.waitUntil) context.waitUntil(write);
    }
    return response;
  }

  // ---- GET /tar/<name>/-/<file> -------------------------------------------
  if (path.startsWith('tar/')) {
    const tail = path.slice(4);
    const name = tail.includes('/-/') ? tail.slice(0, tail.indexOf('/-/')) : tail.split('/').slice(0, -1).join('/');
    const file = tail.slice(tail.lastIndexOf('/') + 1);
    if (!name || !/^[a-z0-9._-]+$/i.test(file)) return json({ error: 'invalid tarball path' }, 400);

    const upstream = `https://registry.npmjs.org/${name}/-/${file}`;
    const cacheKey = new Request(`https://npm-tar.internal/${name}/-/${file}`);
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), 'X-Tar-Cache': 'hit' } });
    }
    const res = await fetch(upstream, { headers: { Accept: 'application/octet-stream' }, cf: { cacheEverything: true, cacheTtl: 31536000 } });
    if (!res.ok) return json({ error: `registry ${res.status} for ${file}` }, res.status === 404 ? 404 : 502);

    const length = Number(res.headers.get('content-length') || 0);
    if (length > 32 * 1024 * 1024) return json({ error: 'tarball too large' }, 413);

    const headers = {
      'Content-Type': 'application/octet-stream',
      // Tarballs are content-addressed by version: safe to keep forever.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Encoding': 'identity',
    };
    const body = await res.arrayBuffer();
    const response = new Response(body, { headers: { ...headers, 'Content-Length': String(body.byteLength) } });
    if (cache && context.waitUntil) {
      context.waitUntil(cache.put(cacheKey, new Response(body, { headers })).catch(() => {}));
    }
    return response;
  }

  return json(
    {
      error: 'unknown npm endpoint',
      routes: ['GET /api/npm/pkg/<name>', 'GET /api/npm/tar/<name>/-/<file>', 'POST /api/npm/resolve', 'GET /api/npm/health'],
    },
    404,
  );
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
