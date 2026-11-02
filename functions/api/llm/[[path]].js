/**
 * Same-origin relay for the **keyless** free routers (Kilo, OpenCode Zen).
 *
 * Why this exists: `api.kilo.ai` is the router that makes AlphaCode free, but it
 * is not reachable from every device. Some browsers drop the `Origin` header,
 * privacy extensions and corporate proxies strip or rewrite cross-origin POSTs,
 * and a few mobile networks MITM the request into a 403. The API answers fine
 * from a worker, so when the direct call fails at the transport level the
 * browser retries here — same origin, no CORS, no extension in the way.
 *
 * What it is not:
 *   • not a proxy for BYOK providers — a request that carries an `Authorization`
 *     or `x-api-key` header is rejected before anything leaves Cloudflare, so a
 *     user's key can never traverse this function;
 *   • not a cache — every request is streamed straight through;
 *   • not open — only two upstreams, two paths, same-origin callers only.
 *
 *   POST /api/llm/kilo/chat/completions   → https://api.kilo.ai/api/gateway/chat/completions
 *   GET  /api/llm/kilo/models             → https://api.kilo.ai/api/gateway/models
 */

/** Only keyless routers. Adding a BYOK provider here would be a key-leak hole. */
const UPSTREAM = {
  kilo: 'https://api.kilo.ai/api/gateway',
  opencode: 'https://opencode.ai/zen/v1',
};

/** Models a request may reach. Anything else is a 404, not a fetch. */
const PATHS = new Set(['chat/completions', 'models']);

const MAX_BODY = 1_500_000; // ~1.5 MB of conversation; larger is a bug, not a prompt
const TIMEOUT_MS = 120_000;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });

/** Headers that would carry a user's own credential. Their presence means BYOK. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key'];

function hasCredential(request) {
  for (const name of CREDENTIAL_HEADERS) {
    const value = request.headers.get(name);
    if (value && value.trim()) return name;
  }
  return '';
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const segments = Array.isArray(params?.path) ? params.path : String(params?.path || '').split('/').filter(Boolean);
  const [relay, ...rest] = segments;
  const target = rest.join('/');
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { Allow: 'GET, POST, OPTIONS', 'Access-Control-Allow-Origin': url.origin },
    });
  }

  if (String(env?.LLM_RELAY || '').toLowerCase() === 'off') {
    return json({ error: 'the relay is disabled on this deployment', hint: 'Unset LLM_RELAY or set it to "on".' }, 503);
  }

  // Same-origin only. A browser sends Origin on cross-site requests, so a page
  // elsewhere cannot borrow this function as a free anonymous proxy.
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    return json({ error: 'cross-origin relay requests are not allowed' }, 403);
  }

  const credential = hasCredential(request);
  if (credential) {
    return json(
      {
        error: `the relay never forwards credentials (saw ${credential})`,
        hint: 'Requests with your own key go straight from the browser to the provider.',
      },
      400,
    );
  }

  const base = UPSTREAM[relay];
  if (!base) return json({ error: `unknown relay "${relay || ''}"`, relays: Object.keys(UPSTREAM) }, 404);
  if (!PATHS.has(target)) return json({ error: `unsupported path "${target}"`, paths: [...PATHS] }, 404);

  if (target === 'models') {
    if (request.method !== 'GET') return json({ error: 'models is a GET' }, 405);
  } else if (request.method !== 'POST') {
    return json({ error: 'chat completions is a POST' }, 405);
  }

  let body;
  if (request.method === 'POST') {
    body = await request.text();
    if (body.length > MAX_BODY) return json({ error: 'request too large', limit: MAX_BODY }, 413);
    try {
      JSON.parse(body);
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }
  }

  const upstreamUrl = `${base}/${target}${target === 'models' ? url.search : ''}`;
  /**
   * OpenCode Zen wants its shared anonymous key on the request. It is a public
   * constant, not the user's credential, so the relay supplies it — the browser
   * deliberately sends nothing, which is what keeps the BYOK rule absolute.
   */
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    Accept: target === 'models' ? 'application/json' : 'text/event-stream',
    'User-Agent': 'AlphaCode-Relay/1.0 (+https://github.com/Time-dev-alt/Nex)',
  };
  if (relay === 'opencode') upstreamHeaders.Authorization = 'Bearer public';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Workers have no event loop to keep alive; Node (the test runner, the local
  // dev server) does, and an armed 2-minute timer would hold the process open.
  timer?.unref?.();

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === 'POST' ? body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    return json(
      {
        error: aborted ? 'upstream timed out' : 'upstream is unreachable from this region',
        relay,
        detail: String(err?.message || err).slice(0, 200),
      },
      aborted ? 504 : 502,
    );
  }

  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.set('X-AlphaCode-Relay', relay);
  const type = upstream.headers.get('Content-Type') || '';
  headers.set('Content-Type', type || (target === 'models' ? 'application/json' : 'text/event-stream'));
  if (upstream.headers.get('Retry-After')) headers.set('Retry-After', upstream.headers.get('Retry-After'));

  // Streamed straight through: the harness parses SSE as it arrives, so the
  // relay must not buffer the answer into a single blob.
  const stream = upstream.body;
  if (!stream) {
    clearTimeout(timer);
    const text = await upstream.text().catch(() => '');
    return new Response(text, { status: upstream.status, headers });
  }
  // The timer is cleared when the body closes, not when the headers arrive.
  const wrapped = stream.pipeThrough(
    new TransformStream({
      flush() {
        clearTimeout(timer);
      },
      cancel() {
        clearTimeout(timer);
      },
    }),
  );
  return new Response(wrapped, { status: upstream.status, headers });
}
