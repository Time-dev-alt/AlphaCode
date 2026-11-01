/**
 * AlphaCode edge facade — a Cloudflare Worker that serves the (obfuscated,
 * hashed, SRI-signed) client from Workers Static Assets and proxies every
 * dynamic route to the AlphaCode Node runtime.
 *
 * Why a facade: the harness needs a real shell (PTY), child processes and
 * node:sqlite, so the runtime lives on a Node host (Cloudflare Container, Fly,
 * Railway, a VPS…). The Worker gives you the edge: TLS, anycast, caching of
 * immutable assets, request filtering and a single stable public URL.
 *
 * Env:
 *   ALPHACODE_ORIGIN  https://runtime.example.com   (required for /api)
 *   ALPHACODE_CLIENT_CACHE  optional, default "public, max-age=31536000, immutable"
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const DYNAMIC = [/^\/api\//, /^\/p\//, /^\/_runtime\//];
const NEVER_CACHE = [/^\/api\//, /^\/p\//];

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'ALLOWALL',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}

function withSecurity(response, { immutable = false } = {}) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  if (immutable) res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (!res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-cache');
  return res;
}

function originOf(env) {
  return String(env.ALPHACODE_ORIGIN || '').replace(/\/+$/, '');
}

async function proxy(request, env) {
  const origin = originOf(env);
  if (!origin) {
    return json(503, {
      error: 'AlphaCode runtime is not connected to this edge deployment.',
      code: 'runtime_unconfigured',
      hint: 'Set ALPHACODE_ORIGIN (wrangler var / dashboard env) to the https URL of the Node runtime that runs the agent harness.',
    });
  }
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set('X-Forwarded-Host', incoming.host);
  headers.set('X-Forwarded-Proto', incoming.protocol.replace(':', ''));
  headers.set('X-Forwarded-For', request.headers.get('cf-connecting-ip') || '');
  headers.set('X-Alphacode-Edge', '1');

  const init = { method: request.method, headers, redirect: 'manual', body: null };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    return json(502, { error: 'Runtime unreachable', code: 'runtime_unreachable', detail: String(err && err.message || err).slice(0, 200) });
  }

  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders.append(k, v);
  }
  // Streaming bodies (SSE agent runs, PTY output) must pass through untouched.
  const isStream = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  if (isStream) {
    outHeaders.set('Cache-Control', 'no-store');
    outHeaders.set('X-Accel-Buffering', 'no');
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!outHeaders.has(k)) outHeaders.set(k, v);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
}

async function serveAsset(request, env, url) {
  const assets = env.ASSETS;
  if (!assets) return json(500, { error: 'Static assets binding is missing (wrangler "assets.binding": "ASSETS").' });
  const pathname = url.pathname;

  const isPage =
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/claim' ||
    /^\/claim\/[A-Za-z0-9_-]{8,64}$/.test(pathname) ||
    !/\.[a-z0-9]{1,8}$/i.test(pathname); // SPA route

  if (isPage) {
    const target = /^\/claim\/[A-Za-z0-9_-]{8,64}$/.test(pathname) ? '/claim.html' : '/index.html';
    const shell = await assets.fetch(new Request(new URL(target, url.origin), request));
    if (!shell.ok) return json(500, { error: `Missing ${target} in the asset bundle. Run "npm run build" before deploying.` });
    return withSecurity(new Response(shell.body, shell));
  }

  const asset = await assets.fetch(request);
  if (asset.status === 404) {
    return withSecurity(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
  }
  const immutable = pathname.startsWith('/assets/') && /\.[0-9a-f]{8}\./.test(pathname);
  return withSecurity(asset, { immutable });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { Allow: 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS', ...SECURITY_HEADERS } });
    }

    if (url.pathname === '/healthz' && !originOf(env)) {
      return json(200, { ok: true, edge: true, runtime: 'unconfigured', version: env.ALPHACODE_VERSION || 'edge' });
    }

    if (DYNAMIC.some((re) => re.test(url.pathname)) || url.pathname === '/healthz') {
      return proxy(request, env);
    }

    return serveAsset(request, env, url);
  },
};
