/**
 * Provider integration test: a local OpenAI-compatible upstream that streams a
 * tool call and then a final answer. Proves the real SSE client, delta assembly,
 * tool execution and BYOK routing work without any external network.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let upstream;
let upstreamPort;
let server;
let base;
let dataDir;
const jar = new Map();
let calls = 0;

function startUpstream() {
  return new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls++;
        const payload = JSON.parse(body || '{}');
        assert.match(req.headers.authorization || '', /^Bearer test-key/, 'BYOK key forwarded');
        assert.ok(Array.isArray(payload.tools) && payload.tools.length > 5, 'tools advertised');
        const toolMessages = (payload.messages || []).filter((m) => m.role === 'tool');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (!toolMessages.length) {
          // stream a tool call in several deltas (as real providers do)
          const args = JSON.stringify({ file_path: 'hello.txt', content: 'streamed by the fake provider\n' });
          send({ id: 'c1', model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'write', arguments: '' } }] } }] });
          for (let i = 0; i < args.length; i += 17) {
            send({ id: 'c1', model: payload.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 17) } }] } }] });
          }
          send({ id: 'c1', model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 500, completion_tokens: 40 } });
        } else {
          const words = ['Done', ' —', ' the', ' file', ' was', ' written', ' through', ' the', ' real', ' streaming', ' client.'];
          send({ id: 'c2', model: payload.model, choices: [{ index: 0, delta: { reasoning_content: 'The tool succeeded, so I can answer.' } }] });
          for (const w of words) send({ id: 'c2', model: payload.model, choices: [{ index: 0, delta: { content: w } }] });
          send({ id: 'c2', model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 700, completion_tokens: 30 } });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = upstream.address().port;
      resolve();
    });
  });
}

async function startAlphaCode() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alphacode-prov-'));
  const port = 4200 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ALPHACODE_PORT: String(port),
      ALPHACODE_HOST: '127.0.0.1',
      ALPHACODE_DATA_DIR: dataDir,
      ALPHACODE_WORKSPACES_DIR: path.join(dataDir, 'workspaces'),
      ALPHACODE_LOG_LEVEL: 'error',
      NODE_ENV: 'test',
      ALPHACODE_MOCK: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(base + '/healthz');
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not boot');
}

function storeCookies(res) {
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

async function api(method, url, body) {
  const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-alphacode-csrf'] = jar.get('ac_csrf') || '';
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

before(async () => {
  await startUpstream();
  await startAlphaCode();
  await api('GET', '/api/bootstrap');
  const reg = await api('POST', '/api/auth/register', { email: `prov-${Date.now()}@example.com`, password: 'a-long-password' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const saved = await api('PUT', '/api/settings', {
    byok: { custom: { key: 'test-key-123', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: 'fake-coder' } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
});

after(async () => {
  server?.kill('SIGTERM');
  upstream?.close();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

test('streams a real provider response, assembles tool deltas and runs the tool', async () => {
  const project = await api('POST', '/api/projects', { name: 'provider-test' });
  const projectId = project.json.project.id;

  const chat = await api('POST', `/api/projects/${projectId}/chat`, { text: 'write a file please', model: 'custom/fake-coder' });
  assert.equal(chat.status, 202, JSON.stringify(chat.json));

  const stream = await fetch(`${base}/api/runs/${chat.json.runId}/stream`, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  const deadline = Date.now() + 30_000;
  let finished = false;
  while (Date.now() < deadline && !finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const ev = JSON.parse(line.slice(5).trim());
      events.push(ev);
      if (ev.type === 'done' || ev.type === 'error') finished = true;
    }
  }
  await reader.cancel().catch(() => {});

  const model = events.find((e) => e.type === 'model');
  assert.equal(model.provider, 'custom');
  assert.equal(model.via, 'byok');

  const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.text).join('');
  assert.match(reasoning, /tool succeeded/);

  const writeEnd = events.find((e) => e.type === 'tool_end' && e.name === 'write');
  assert.ok(writeEnd, 'write tool executed');
  assert.equal(writeEnd.ok, true);

  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.match(text, /real streaming client/);

  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'run completed');
  assert.equal(done.finishReason, 'stop');

  const file = await api('GET', `/api/projects/${projectId}/file?path=hello.txt`);
  assert.equal(file.status, 200);
  assert.match(file.json.content, /streamed by the fake provider/);
  assert.ok(calls >= 2, 'two model calls (tool then answer)');
});

test('falls back to the next provider when one fails', async () => {
  // Point the BYOK custom provider at a dead port; the chain must fail over.
  await api('PUT', '/api/settings', { byok: { custom: { key: 'k', baseUrl: 'http://127.0.0.1:9/v1', model: 'dead-model' } } });
  const project = await api('POST', '/api/projects', { name: 'fallback-test' });
  const chat = await api('POST', `/api/projects/${project.json.project.id}/chat`, { text: 'hello there', model: 'custom/dead-model' });
  assert.equal(chat.status, 202, JSON.stringify(chat.json));
  const stream = await fetch(`${base}/api/runs/${chat.json.runId}/stream`, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  const deadline = Date.now() + 25_000;
  let finished = false;
  while (Date.now() < deadline && !finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const ev = JSON.parse(line.slice(5).trim());
      events.push(ev);
      if (ev.type === 'done' || ev.type === 'error') finished = true;
    }
  }
  await reader.cancel().catch(() => {});
  assert.ok(events.some((e) => e.type === 'provider_error'), 'first provider failed');
  assert.ok(events.some((e) => e.type === 'notice' && /trying the next model/i.test(e.text || '')), 'failover notice emitted');
  // Offline sandbox: every remaining provider fails, so we expect a graceful error.
  assert.ok(events.some((e) => e.type === 'done' || e.type === 'error'), 'run terminated cleanly');
});
