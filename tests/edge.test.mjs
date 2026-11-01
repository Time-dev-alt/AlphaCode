/**
 * Edge facade tests: the Cloudflare Worker is plain ESM, so the whole routing
 * surface is testable in Node with a fake ASSETS binding and a stubbed fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const worker = (await import('../src/edge/worker.mjs')).default;

function assets(map) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const body = map[url.pathname];
      if (body === undefined) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html' },
      });
    },
  };
}

const ENV = (extra = {}) => ({
  ASSETS: assets({
    '/index.html': '<!doctype html><title>AlphaCode</title>',
    '/claim.html': '<!doctype html><title>Claim</title>',
    '/assets/app.1234abcd.js': 'export const x = 1;',
  }),
  ...extra,
});

test('serves the app shell from static assets with security headers', async () => {
  const res = await worker.fetch(new Request('https://alphacode.example.com/'), ENV());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /AlphaCode/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('strict-transport-security') || '', /max-age/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('SPA routes fall back to index.html, claim routes to claim.html', async () => {
  const spa = await worker.fetch(new Request('https://x.dev/projects/abc'), ENV());
  assert.match(await spa.text(), /AlphaCode/);
  const claim = await worker.fetch(new Request('https://x.dev/claim/abcdefgh12345678'), ENV());
  assert.match(await claim.text(), /Claim/);
});

test('immutable caching only for hashed assets', async () => {
  const res = await worker.fetch(new Request('https://x.dev/assets/app.1234abcd.js'), ENV());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /immutable/);
  const missing = await worker.fetch(new Request('https://x.dev/assets/nope.1234abcd.js'), ENV());
  assert.equal(missing.status, 404);
});

test('API calls without a runtime answer 503 with a precise hint', async () => {
  const res = await worker.fetch(new Request('https://x.dev/api/bootstrap'), ENV());
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'runtime_unconfigured');
  assert.match(body.hint, /ALPHACODE_ORIGIN/);
});

test('proxies to the runtime, forwards method/body and streams SSE untouched', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('data: {"type":"text"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  };
  try {
    const res = await worker.fetch(
      new Request('https://x.dev/api/projects/p1/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ text: 'hi' }),
      }),
      ENV({ ALPHACODE_ORIGIN: 'https://runtime.example.com/' }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://runtime.example.com/api/projects/p1/runs');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.get('x-forwarded-for'), '203.0.113.9');
    assert.equal(calls[0].init.headers.get('x-alphacode-edge'), '1');
    assert.match(res.headers.get('content-type') || '', /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runtime failures surface as 502 JSON, not a stack trace', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const res = await worker.fetch(new Request('https://x.dev/api/bootstrap'), ENV({ ALPHACODE_ORIGIN: 'https://runtime.example.com' }));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'runtime_unreachable');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('edge answers /healthz alone when no runtime is attached', async () => {
  const res = await worker.fetch(new Request('https://x.dev/healthz'), ENV());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.edge, true);
  assert.equal(body.runtime, 'unconfigured');
});
