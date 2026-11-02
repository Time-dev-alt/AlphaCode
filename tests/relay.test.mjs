/**
 * The same-origin LLM relay, tested as a plain function.
 *
 * A relay is the one place in this architecture where a request passes through
 * infrastructure we operate, so the tests are about the *guarantees* rather than
 * the plumbing: BYOK credentials never cross, only two upstreams and two paths
 * exist, cross-site callers are refused, and SSE is passed through as a stream
 * instead of being buffered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/llm/[[path]].js';

const ORIGIN = 'https://alphacode.example.com';

function makeRequest({ method = 'POST', path = ['kilo', 'chat', 'completions'], headers = {}, body = '{"model":"kilo-auto/free","messages":[]}', search = '' } = {}) {
  return new Request(`${ORIGIN}/api/llm/${path.join('/')}${search}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'POST' ? body : undefined,
  });
}

function call(opts = {}, env = {}) {
  const request = opts.request || makeRequest(opts);
  const params = opts.params || { path: opts.path || ['kilo', 'chat', 'completions'] };
  return onRequest({ request, env, params });
}

/** Run `fn` with a stubbed global fetch, restoring it afterwards. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('rejects a request that carries a BYOK credential', async () => {
  for (const header of ['Authorization', 'x-api-key', 'x-goog-api-key', 'api-key']) {
    const res = await call({ headers: { [header]: 'sk-live-secret' } });
    assert.equal(res.status, 400, `${header} must be refused`);
    const body = await res.json();
    assert.match(body.error, /never forwards credentials/i);
  }
});

test('rejects cross-origin callers so it cannot be borrowed as a proxy', async () => {
  const res = await call({ headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('only the keyless routers are relayed', async () => {
  const res = await call({ path: ['openai', 'chat', 'completions'] });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /unknown relay/);
});

test('only chat completions and the model list are reachable', async () => {
  for (const path of [['kilo', 'keys'], ['kilo', 'chat', 'completions', 'extra'], ['kilo', '../etc']]) {
    const res = await call({ path });
    assert.equal(res.status, 404, path.join('/'));
  }
});

test('the relay can be switched off for a deployment', async () => {
  const res = await call({}, { LLM_RELAY: 'off' });
  assert.equal(res.status, 503);
});

test('rejects a non-JSON body and an oversized one', async () => {
  const bad = await call({ body: 'not json' });
  assert.equal(bad.status, 400);
  const huge = await call({ body: JSON.stringify({ pad: 'x'.repeat(1_600_000) }) });
  assert.equal(huge.status, 413);
});

test('POSTs the body upstream without any credential header', async () => {
  let seen;
  const res = await withFetch(
    async (url, init) => {
      seen = { url: String(url), headers: init.headers, body: init.body, method: init.method };
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
    () => call(),
  );
  assert.equal(res.status, 200);
  assert.equal(seen.url, 'https://api.kilo.ai/api/gateway/chat/completions');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(seen.headers['x-api-key'], undefined);
  assert.deepEqual(JSON.parse(seen.body), { model: 'kilo-auto/free', messages: [] });
  assert.equal(res.headers.get('X-AlphaCode-Relay'), 'kilo');
  assert.equal(res.headers.get('Content-Type'), 'text/event-stream');
  assert.match(await res.text(), /\[DONE\]/);
});

test('OpenCode gets its shared anonymous key from the relay, never from the browser', async () => {
  let seenHeaders;
  await withFetch(
    async (_url, init) => {
      seenHeaders = init.headers;
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    () => call({ path: ['opencode', 'chat', 'completions'], body: '{"model":"big-pickle","messages":[]}' }),
  );
  assert.equal(seenHeaders.Authorization, 'Bearer public');
});

test('a caller-supplied Authorization is still refused for OpenCode', async () => {
  const res = await call({ path: ['opencode', 'chat', 'completions'], headers: { Authorization: 'Bearer sk-user' } });
  assert.equal(res.status, 400);
});

test('the model list comes back as JSON', async () => {
  const res = await withFetch(
    async (url) =>
      new Response(JSON.stringify({ data: [{ id: 'kilo-auto/free' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    () => call({ method: 'GET', path: ['kilo', 'models'] }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: [{ id: 'kilo-auto/free' }] });
});

test('an upstream failure is reported as a relay error, not a crash', async () => {
  const res = await withFetch(
    async () => {
      throw new TypeError('network down');
    },
    () => call(),
  );
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.relay, 'kilo');
  assert.match(body.error, /unreachable/);
});

test('an upstream HTTP error is passed through with its status', async () => {
  const res = await withFetch(
    async () =>
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '20' },
      }),
    () => call(),
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '20');
});

test('the SSE body is streamed, not buffered into one blob', async () => {
  const res = await withFetch(
    async () =>
      new Response('data: not-really-read\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    () => call(),
  );
  assert.ok(res.body, 'a readable stream is returned');
  assert.equal(typeof res.body.getReader, 'function');
});
