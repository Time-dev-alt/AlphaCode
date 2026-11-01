/**
 * Real DOM boot test. The browser bundle is import-free after concatenation, so
 * it can be executed inside jsdom with a stubbed API — which catches the class
 * of bug static checks miss (a ReferenceError in boot() blanks the whole app).
 *
 * Skipped automatically when jsdom is not installed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const skip = JSDOM ? false : 'jsdom is not installed (npm i -D jsdom)';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BOOTSTRAP = {
  user: null,
  guest: true,
  sessionId: 'sess',
  csrf: 'csrf-token',
  routing: { tier: 'guest', signedIn: false, byok: [], chain: ['kilo'], quota: { limited: false, used: 0, limit: null } },
  quota: { used: 0, limit: null, unlimited: true },
  projects: [{ id: 'p1', name: 'Launch Page', updatedAt: Date.now() }],
  providers: { opencode: { id: 'opencode', label: 'OpenCode Zen', platformConfigured: true } },
  deploy: { cloudflare: { connected: false }, netlify: { connected: false }, vercel: { connected: false } },
  runtime: { node: 'v22.22.3', python: '3.11.2', npm: '10.9.8' },
  capabilities: { terminal: true, database: true, dailyRequests: 40, guestModel: 'kilo-auto/free', maxIterations: 48 },
  contextWindow: 200000,
  prefs: { mode: 'default' },
  version: '2.0.0',
  instance: { registration: true, mock: true },
};

function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];

  window.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/bootstrap')) return json(BOOTSTRAP);
    if (u.includes('/api/models')) {
      return json({ models: [{ id: 'kilo-auto/free', name: 'Kilo Auto', provider: 'kilo', free: true, context: 256000 }], providers: [{ id: 'kilo', label: 'Kilo' }] });
    }
    if (/\/api\/projects\/p1$/.test(u)) {
      return json({
        project: { id: 'p1', name: 'Launch Page' },
        activeThread: { id: 't1', title: 'Session' },
        threads: [{ id: 't1', title: 'Session' }],
        messages: [],
        files: [],
        deployments: [],
        git: { branch: 'main', changes: [] },
        running: false,
        deploy: {},
      });
    }
    return json({ ok: true, projects: [], files: [], messages: [] });
  };
  window.EventSource = class {
    constructor() {
      this.readyState = 0;
    }
    addEventListener() {}
    close() {}
  };
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.scrollTo = () => {};
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(e.reason));
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  const source = ['util.js', 'term.js', 'app.js']
    .map((file) =>
      fs
        .readFileSync(path.join(ROOT, 'public', 'assets', file), 'utf8')
        .replace(/^\s*import [^;]+;\s*$/gm, '')
        .replace(/\bexport\s+(function|class|const|let|var|async)/g, '$1'),
    )
    .join('\n;\n');

  // Expose internals for assertions; the app itself stays a closure.
  const harness = `${source}\n;window.__app = { state, renderProjects, handleRunEvent, handleSlash, appendNotice, setView };`;
  new window.Function(harness).call(window);

  return { dom, window, errors, calls, restore: () => (console.error = realError) };
}

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));

let ctx;
before(async () => {
  if (!JSDOM) return;
  ctx = boot();
  await wait(500);
});
after(() => ctx?.restore());

test('boots the SPA in a DOM without a single error', { skip }, () => {
  const { window, errors } = ctx;
  assert.deepEqual(errors, [], 'no runtime errors during boot');
  assert.equal(window.document.querySelector('#status-text').textContent, 'ready');
  assert.ok(window.document.querySelector('.welcome'), 'welcome screen rendered');
});

test('renders the project list from bootstrap', { skip }, () => {
  const { window } = ctx;
  const rows = window.document.querySelectorAll('#project-list .list-item');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Launch Page/);
});

test('shows the guest model and the free-tier quota chip', { skip }, () => {
  const { window } = ctx;
  assert.equal(window.document.querySelector('#pill-model-txt').textContent.trim(), 'auto');
  assert.equal(window.document.querySelector('#chip-quota-txt').textContent, 'free tier');
  assert.equal(window.document.querySelector('#quota-label').textContent, 'guest · free');
  assert.match(window.document.querySelector('#quota-hint').textContent, /Free forever on the Kilo router/);
});

test('a streamed run renders text, a tool card and the context meter', { skip }, () => {
  const { window } = ctx;
  const app = window.__app;
  app.setView('chat');
  app.handleRunEvent({ type: 'start' });
  app.handleRunEvent({ type: 'model', provider: 'mock', model: 'demo-1', via: 'demo' });
  app.handleRunEvent({ type: 'text', text: 'Building it now.' });
  app.handleRunEvent({ type: 'text_done', text: 'Building it now.' });
  app.handleRunEvent({ type: 'tool_start', toolCallId: 'c1', name: 'bash', title: 'ls -la', args: { command: 'ls -la' } });
  app.handleRunEvent({ type: 'tool_output', text: 'index.html\n' });
  app.handleRunEvent({ type: 'tool_end', toolCallId: 'c1', name: 'bash', ok: true, summary: 'exit 0', display: { kind: 'bash', command: 'ls -la', exitCode: 0 } });
  app.handleRunEvent({ type: 'usage', usage: { inputTokens: 4200, contextWindow: 200000, calls: 1 } });
  app.handleRunEvent({ type: 'done', steps: 2, usage: { input: 4200, output: 300, calls: 1 }, filesChanged: ['index.html'], quota: { used: 1, limit: 40 } });

  const doc = window.document;
  const transcript = doc.querySelector('#transcript').textContent;
  assert.match(transcript, /Building it now\./);
  assert.ok(doc.querySelectorAll('.tool-card, .tool').length >= 1, 'tool card rendered');
  const meter = doc.querySelector('#ctx-meter');
  assert.equal(meter.textContent, '2%', 'context meter uses tokens/window, not a magic constant');
  assert.match(meter.title, /4,200 of 200,000/);
});

test('slash commands render diagnostics', { skip }, async () => {
  const { window } = ctx;
  await window.__app.handleSlash('/doctor');
  assert.match(window.document.querySelector('#transcript').textContent, /Doctor/);
  await window.__app.handleSlash('/cost');
  assert.match(window.document.querySelector('#transcript').textContent, /Cost & usage/);
});

test('permission cards can be answered', { skip }, async () => {
  const { window } = ctx;
  window.__app.handleRunEvent({ type: 'permission', requestId: 'r1', title: 'Run rm -rf build', kind: 'bash', command: 'rm -rf build', risks: ['destructive'] });
  const card = window.document.querySelector('.perm-card');
  assert.ok(card, 'permission card rendered');
  assert.match(card.textContent, /Run rm -rf build/);
  assert.ok(card.querySelector('[data-allow]') && card.querySelector('[data-deny]'));
  card.querySelector('[data-deny]').click();
  await wait(120);
  assert.ok(
    ctx.calls.some((u) => /\/api\/runs\/.*\/permission/.test(u)),
    'denying posts to the permission endpoint',
  );
  assert.match(card.textContent, /denied/);
});
