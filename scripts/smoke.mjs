#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the real server on a scratch data dir and
 * exercises auth, the agent loop, files, shell, terminal PTY, SQLite editing,
 * deployments/claims and path sandboxing.
 *
 *   node --disable-warning=ExperimentalWarning scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 3400 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'alphacode-smoke-'));

const jar = new Map();
function cookies() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}
async function req(method, url, body, extraHeaders = {}) {
  const headers = { cookie: cookies(), ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-alphacode-csrf'] = jar.get('ac_csrf') || '';
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json, headers: res.headers, text };
}

const results = [];
function check(name, fn) {
  results.push({ name, fn });
}

async function run() {
  console.log(`\n▸ AlphaCode smoke test\n  data: ${DATA}\n  base: ${BASE}\n`);
  const server = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.mjs')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ALPHACODE_PORT: String(PORT),
        ALPHACODE_HOST: '127.0.0.1',
        ALPHACODE_DATA_DIR: DATA,
        ALPHACODE_WORKSPACES_DIR: path.join(DATA, 'workspaces'),
        ALPHACODE_MOCK: '1',
        ALPHACODE_LOG_LEVEL: 'warn',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d.toString()));
  server.stderr.on('data', (d) => (serverLog += d.toString()));

  try {
    await waitForServer();
    for (const { name, fn } of results) {
      process.stdout.write(`  • ${name} … `);
      try {
        await fn();
        console.log('ok');
      } catch (err) {
        console.log('FAIL');
        console.error(`\n    ${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}\n`);
        throw err;
      }
    }
    console.log('\n✔ all smoke checks passed\n');
  } catch (err) {
    console.error('\n✕ smoke test failed\n');
    console.error(serverLog.slice(-4000));
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    try {
      fs.rmSync(DATA, { recursive: true, force: true });
    } catch {}
  }
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(BASE + '/healthz');
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

/* ------------------------------------------------------------------ tests -- */
check('serves the SPA shell with security headers', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /AlphaCode/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /frame-ancestors/);
  assert.match(csp, /default-src 'self'/);
});

check('reports health as JSON (a non-/api route)', async () => {
  const res = await fetch(BASE + '/healthz');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.uptimeMs >= 0, 'uptime reported');
  assert.equal(typeof body.version, 'string');
  assert.ok(body.runtime?.node, 'runtime facts included');
});

check('issues a guest session + CSRF token', async () => {
  const res = await req('GET', '/api/bootstrap');
  assert.equal(res.status, 200);
  assert.equal(res.json.guest, true);
  assert.ok(res.json.csrf, 'csrf token present');
  assert.equal(jar.get('ac_sid')?.length > 10, true);
  assert.equal(res.json.capabilities.terminal, true);
});

check('registers an account and migrates guest ownership', async () => {
  const res = await req('POST', '/api/auth/register', { email: `smoke-${Date.now()}@example.com`, password: 'correct horse battery' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.ok(res.json.user.id.startsWith('u_'));
  const me = await req('GET', '/api/auth/me');
  assert.equal(me.json.user.email.includes('@example.com'), true);
});

check('rejects CSRF-less mutations', async () => {
  const res = await fetch(BASE + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies() }, body: '{"name":"nope"}' });
  assert.equal(res.status, 403);
});

check('creates a project workspace', async () => {
  const res = await req('POST', '/api/projects', { name: 'Smoke app' });
  assert.equal(res.status, 201);
  assert.ok(res.json.project.id.startsWith('p_'));
  globalThis.projectId = res.json.project.id;
  const state = await req('GET', `/api/projects/${res.json.project.id}`);
  assert.equal(state.status, 200);
  assert.equal(state.json.project.name, 'Smoke app');
  globalThis.threadId = state.json.activeThread.id;
});

let runEvents = [];
check('runs the agent loop end-to-end (todos → write → bash → final)', async () => {
  const res = await req('POST', `/api/projects/${globalThis.projectId}/chat`, {
    text: 'Build a small landing page and prove the shell works',
    model: '',
  });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  const runId = res.json.runId;

  const stream = await fetch(`${BASE}/api/runs/${runId}/stream`, { headers: { cookie: cookies() } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 45_000;
  let done = false;
  while (Date.now() < deadline && !done) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const ev = JSON.parse(dataLine.slice(5).trim());
      runEvents.push(ev);
      if (ev.type === 'done' || ev.type === 'error') done = true;
    }
  }
  await reader.cancel().catch(() => {});
  const types = runEvents.map((e) => e.type);
  assert.ok(types.includes('start'), 'start event');
  assert.ok(runEvents.some((e) => e.type === 'tool_end' && e.name === 'todo_write'), 'todo tool ran');
  assert.ok(runEvents.some((e) => e.type === 'tool_end' && e.name === 'write' && e.ok), 'write tool ran');
  const bash = runEvents.find((e) => e.type === 'tool_end' && e.name === 'bash');
  assert.ok(bash, 'bash tool ran');
  assert.equal(bash.ok, true, 'bash succeeded');
  const doneEv = runEvents.find((e) => e.type === 'done');
  assert.ok(doneEv, 'done event');
  assert.equal(doneEv.finishReason !== 'error', true);
});

check('persisted the generated file and exposes it through the FS API', async () => {
  const files = await req('GET', `/api/projects/${globalThis.projectId}/files`);
  assert.equal(files.status, 200);
  assert.ok(files.json.files.some((f) => f.path === 'index.html'), 'index.html in tree');
  const file = await req('GET', `/api/projects/${globalThis.projectId}/file?path=index.html`);
  assert.equal(file.status, 200);
  assert.match(file.json.content, /Built by AlphaCode/);
  // editor save round-trip
  const saved = await req('PUT', `/api/projects/${globalThis.projectId}/file`, { path: 'notes.txt', content: 'hello from the editor\n' });
  assert.equal(saved.status, 200);
});

check('blocks path traversal outside the workspace', async () => {
  const res = await req('GET', `/api/projects/${globalThis.projectId}/file?path=${encodeURIComponent('../../../../etc/passwd')}`);
  assert.equal(res.status, 403, `expected 403, got ${res.status} ${JSON.stringify(res.json)}`);
});

check('spawns a real PTY shell and runs a command', async () => {
  const t = await req('POST', `/api/projects/${globalThis.projectId}/terminal`, { cols: 100, rows: 30 });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  assert.equal(t.json.terminal.backend === 'native' || t.json.terminal.backend === 'script' || t.json.terminal.backend === 'pipe', true);
  const sid = t.json.terminal.id;
  const ac = new AbortController();
  const stream = await fetch(`${BASE}/api/terminal/${sid}/stream`, { headers: { cookie: cookies() }, signal: ac.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  await req('POST', `/api/terminal/${sid}/input`, { data: 'echo TERMINAL_$((1+1))_OK\r' });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !out.includes('TERMINAL_2_OK')) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  ac.abort();
  assert.match(out, /TERMINAL_2_OK/, 'shell echoed the computed value');
  await req('DELETE', `/api/terminal/${sid}`);
});

check('edits a SQLite database (create, insert, query, update)', async () => {
  const schema = await req('POST', `/api/projects/${globalThis.projectId}/database/exec`, {
    path: 'app.db',
    sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT); INSERT INTO users (name, role) VALUES ('Ada','admin'),('Linus','dev');",
  });
  assert.equal(schema.status, 200, JSON.stringify(schema.json));
  const rows = await req('GET', `/api/projects/${globalThis.projectId}/database/rows?path=app.db&table=users`);
  assert.equal(rows.status, 200);
  assert.equal(rows.json.total, 2);
  const id = rows.json.rows[0].__rowid;
  const upd = await req('POST', `/api/projects/${globalThis.projectId}/database/row`, { path: 'app.db', table: 'users', rowid: id, values: { role: 'owner' }, action: 'update' });
  assert.equal(upd.status, 200);
  const after = await req('POST', `/api/projects/${globalThis.projectId}/database/query`, { path: 'app.db', sql: "SELECT role FROM users WHERE name='Ada'" });
  assert.equal(after.json.rows[0].role, 'owner');
  const writeBlocked = await req('POST', `/api/projects/${globalThis.projectId}/database/query`, { path: 'app.db', sql: 'DROP TABLE users' });
  assert.equal(writeBlocked.status, 400, 'query endpoint refuses writes');
});

let claimToken = '';
check('publishes a claimable preview and serves it sandboxed', async () => {
  const res = await req('POST', `/api/projects/${globalThis.projectId}/deploy`, { target: 'preview', projectName: 'smoke-app' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.provider, 'preview');
  assert.match(res.json.url, /\/p\/dep_/);
  claimToken = res.json.claimToken;
  assert.ok(claimToken);
  const page = await fetch(res.json.url.startsWith('http') ? res.json.url : BASE + res.json.url);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Built by AlphaCode/);
  assert.match(page.headers.get('content-security-policy') || '', /sandbox/);
});

check('serves a working claim page (CSRF-aware, no global secrets)', async () => {
  const res = await fetch(`${BASE}/claim/${claimToken}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Claim this app/);
  // The page signs users in and claims via POST: it must send the CSRF header.
  assert.match(html, /X-Alphacode-CSRF/);
  assert.match(html, /\/api\/bootstrap/);
});

check('accepts a claim for the deployment', async () => {
  const info = await req('GET', `/api/claim/${claimToken}`);
  assert.equal(info.status, 200);
  assert.equal(info.json.requiresAuth, false);
  const claim = await req('POST', `/api/claim/${claimToken}`, {});
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const again = await req('GET', `/api/claim/${claimToken}`);
  assert.equal(again.json.deployment.claimed, true);
});

check('rejects a second claim of the same deployment', async () => {
  const res = await req('POST', `/api/claim/${claimToken}`, {});
  assert.equal(res.status, 400);
});

check('exposes runtime versions and a model catalogue', async () => {
  const rt = await req('GET', '/api/runtime');
  assert.equal(rt.status, 200);
  assert.ok(rt.json.runtime.node.version);
  assert.ok(rt.json.runtime.python.version);
  const models = await req('GET', '/api/models');
  assert.equal(models.status, 200);
  assert.ok(Array.isArray(models.json.providers));
});

check('enforces the daily request allowance for signed-in users', async () => {
  // Burn the remaining allowance with cheap plan-mode turns, then expect 429.
  let limited = null;
  for (let i = 0; i < 45; i++) {
    const res = await req('POST', `/api/projects/${globalThis.projectId}/chat`, { text: 'hi', mode: 'plan' });
    if (res.status === 429) {
      limited = res;
      break;
    }
    if (res.status === 202) {
      const es = await fetch(`${BASE}/api/runs/${res.json.runId}/stream`, { headers: { cookie: cookies() } });
      const reader = es.body.getReader();
      const until = Date.now() + 4000;
      while (Date.now() < until) {
        const { done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ done: true }), 400))]);
        if (done) break;
      }
      await reader.cancel().catch(() => {});
    }
  }
  assert.ok(limited, 'eventually hit the daily limit');
  assert.equal(limited.json.code, 'daily_limit', `unexpected code: ${limited.json.code}`);
});

check('serves 404 JSON for unknown endpoints', async () => {
  const res = await req('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.code, 'not_found');
});

run();
