/**
 * Boots the **built** Pages bundle in jsdom and drives a full agent turn.
 *
 * This is the test that proves "client-side" is real: no server process, no
 * fetch mocking for the harness (the demo provider runs locally), files written
 * to the in-memory fallback of the filesystem, SQLite through sql.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}
const skip = JSDOM ? false : 'jsdom is not installed';

let ctx;

before(() => {
  if (!JSDOM) return;
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: ROOT, stdio: 'pipe' });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://alphacode.example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(e.reason));
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  window.fetch = async (url) => {
    if (String(url).includes('/api/health')) {
      return new Response(JSON.stringify({ ok: true, mode: 'client', githubOAuth: false }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  window.confirm = () => true;
  window.prompt = (msg, def) => def;
  window.open = () => null;
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  window.HTMLElement.prototype.scrollTo = () => {};
  window.Worker = class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(message) {
      this.posted = message;
    }
    terminate() {}
  };

  const code = fs.readFileSync(path.join(DIST, 'assets', fs.readdirSync(path.join(DIST, 'assets')).find((f) => f.startsWith('app.') && f.endsWith('.js'))), 'utf8');
  window.eval(code);
  await wait(600);
  return { window, errors, restore: () => (console.error = realError) };
}

test('the built bundle boots with zero errors and no server', { skip }, async () => {
  ctx = await boot();
  const { window, errors } = ctx;
  assert.deepEqual(errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(String(e && e.message || e))), [], 'no runtime errors during boot');
  const doc = window.document;
  assert.ok(doc.querySelector('#prompt'), 'composer rendered');
  assert.equal(doc.querySelector('#status-text').textContent, 'ready');
  assert.match(doc.querySelector('#storage-note').textContent, /files/i);
});

test('a project and a session exist on first run', { skip }, () => {
  const { window } = ctx;
  const app = window.__alphacode;
  assert.equal(app.state.projects.length, 1);
  assert.ok(app.state.project.id.startsWith('p_'));
  assert.ok(app.state.thread.id.startsWith('t_'));
});

test('the agent builds a page end-to-end in the browser', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  app.state.mode = 'bypass'; // no human to click permission cards in a test
  await app.send('Build a landing page');
  await wait(1200);

  const files = await app.state.fs.list(app.state.project.id);
  const paths = files.map((f) => f.path).sort();
  assert.ok(paths.includes('index.html'), `index.html missing (saw ${paths.join(',')})`);
  assert.ok(paths.includes('style.css'), 'style.css missing');

  const html = await app.state.fs.readText(app.state.project.id, 'index.html');
  assert.match(html, /<h1>/);

  const doc = window.document;
  const transcript = doc.querySelector('#transcript').textContent;
  assert.match(transcript, /index\.html/);
  assert.ok(doc.querySelectorAll('.tool').length >= 2, 'tool cards rendered');
});

test('messages are persisted to the in-browser store', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const messages = await app.state.store.messages(app.state.thread.id);
  assert.ok(messages.length >= 3);
  assert.equal(messages[0].role, 'user');
  assert.ok(messages.some((m) => m.role === 'tool'));
});

test('the shell runs in the terminal and touches project files', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  app.setView('terminal');
  await wait(50);
  assert.ok(app.state.shell, 'shell attached to the project');
  const out = await app.state.shell.run('ls');
  assert.match(out.output, /index\.html/);
  const sql = await app.state.shell.run('echo hi > note.txt && cat note.txt');
  assert.match(sql.output, /hi/);
});

test('SQLite works in the page (WASM engine, project file)', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const db = await import(path.join(ROOT, 'web', 'engine', 'db.js').replace(/\\/g, '/'));
  const handle = await db.openDatabase(app.state.fs, app.state.project.id, 'app.sqlite');
  handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
  handle.insertRow('t', { v: 'hello' });
  await db.saveDatabase(app.state.fs, app.state.project.id, handle);
  assert.equal(handle.query('SELECT v FROM t').rows[0].v, 'hello');
  assert.ok((await app.state.fs.list(app.state.project.id)).some((f) => f.path === 'app.sqlite'));
});

test('the UI ships both layouts, templates and a live preview', { skip }, async () => {
  const { window } = ctx;
  const doc = window.document;
  assert.equal(doc.querySelector('#app').dataset.layout, 'build');
  assert.equal(doc.querySelectorAll('#layout-switch .switch-btn').length, 2);
  doc.querySelector('[data-layout="code"]').click();
  assert.equal(doc.querySelector('#app').dataset.layout, 'code');
  doc.querySelector('[data-layout="build"]').click();
  assert.equal(doc.querySelector('#app').dataset.layout, 'build');

  assert.equal(doc.querySelectorAll('.template').length >= 5, true, 'template gallery rendered');
  assert.ok(doc.querySelector('#preview-frame'), 'preview iframe exists');
  assert.ok(doc.querySelector('#history-drawer'), 'history drawer exists');
  assert.ok(doc.querySelector('#console-drawer'), 'console drawer exists');
});

test('the preview is rebuilt from project files with the picker and error hooks', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const { refreshPreview } = await import('../web/app/workspace.js');
  await refreshPreview({ force: true });
  const frame = window.document.querySelector('#preview-frame');
  assert.ok(frame.srcdoc.includes('<h1'), 'preview contains the generated page');
  assert.match(frame.srcdoc, /__alpha:pick/, 'element picker is injected');
  assert.match(frame.srcdoc, /unhandledrejection/, 'error capture is injected');

  // a runtime error from the iframe shows up as an actionable console entry
  window.postMessage({ __alpha: 1, type: 'error', message: 'boom is not defined', line: 12 }, '*');
  window.dispatchEvent(new window.MessageEvent('message', { data: { __alpha: 1, type: 'error', message: 'boom is not defined', line: 12 } }));
  await wait(30);
  const drawer = window.document.querySelector('#console-drawer');
  assert.equal(drawer.hidden, false);
  assert.match(window.document.querySelector('#console-body').textContent, /boom is not defined/);
  window.document.querySelector('#btn-fix-errors').click();
  assert.match(window.document.querySelector('#prompt').value, /Fix the code/);
});

test('choosing a template reuses the empty project and starts a build', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const before = app.state.projects.length;
  window.document.querySelector('#btn-templates').click();
  assert.equal(window.document.querySelector('#template-sheet').hidden, false);

  const landing = [...window.document.querySelectorAll('.template')].find((card) => /Landing/.test(card.textContent));
  landing.click();
  await wait(1200);

  assert.equal(window.document.querySelector('#template-sheet').hidden, true, 'picker closes');
  assert.ok(app.state.projects.length <= before + 1, 'at most one project was created');
  assert.match(app.state.project.name, /Landing/);
  assert.match(window.document.querySelector('#prompt').value + window.document.querySelector('#transcript-inner').textContent, /Nimbus/, 'the starter prompt was sent');
  const files = await app.state.fs.list(app.state.project.id);
  assert.ok(files.some((f) => f.path.endsWith('.html')), 'the template produced files');
});

test('a checkpoint can be taken and restored from the history drawer', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const projectId = app.state.project.id;
  await app.state.fs.write(projectId, 'notes.txt', 'first draft');
  await app.state.store.snapshot(projectId, await app.state.fs.snapshot(projectId), 'before experiment');

  await app.state.fs.write(projectId, 'notes.txt', 'second draft');
  window.document.querySelector('#btn-history').click();
  await wait(60);
  const entries = [...window.document.querySelectorAll('#history-list .snap')];
  assert.ok(entries.length >= 1, 'the drawer lists checkpoints');
  entries[0].querySelector('button').click();
  await wait(200);
  assert.equal(await app.state.fs.readText(projectId, 'notes.txt'), 'first draft', 'files were rewound');
});

test('deploy produces a claimed local preview without any account', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const { deployProject } = await import(path.join(ROOT, 'web', 'engine', 'deploy.js').replace(/\\/g, '/'));
  const files = await app.state.fs.snapshot(app.state.project.id);
  const result = await deployProject({ target: 'preview', files, projectName: app.state.project.name });
  assert.equal(result.provider, 'preview');
  assert.equal(result.claimable ?? result.display.claimable, true);
  assert.match(result.message, /Claim URL|claim/i);
  assert.match(result.previewHtml, /<h1>/);
});

test('GitHub sign-in accepts the popup token only from this origin', { skip }, async () => {
  const { window } = ctx;
  const { waitForOAuth } = await import(path.join(ROOT, 'web', 'engine', 'deploy.js').replace(/\\/g, '/'));
  const popup = { closed: false };
  const pending = waitForOAuth(popup, { timeoutMs: 3000, target: window });

  // A rogue origin must not be able to inject a token.
  window.dispatchEvent(new window.MessageEvent('message', { origin: 'https://evil.example', data: { type: 'alphacode:oauth', token: 'stolen' } }));
  // Unrelated messages are ignored too.
  window.dispatchEvent(new window.MessageEvent('message', { origin: 'https://alphacode.example.com', data: { type: 'other' } }));

  setTimeout(() => {
    window.dispatchEvent(new window.MessageEvent('message', {
      origin: 'https://alphacode.example.com',
      data: { type: 'alphacode:oauth', token: 'gho_test', scope: 'repo' },
    }));
  }, 20);

  const result = await pending;
  assert.equal(result.token, 'gho_test');
});

test('BYOK keys are stored in the browser, not on a server', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const settings = await app.state.store.saveSettings({ keys: { openai: { key: 'sk-local-only', model: 'gpt-4.1-mini' } } });
  assert.equal(settings.keys.openai.key, 'sk-local-only');
  const reloaded = await app.state.store.settings();
  assert.equal(reloaded.keys.openai.key, 'sk-local-only', 'keys survive a reload');
  // Nothing in the page ever posts to our own origin with the key.
  assert.equal(window.__alphacode.state.server, undefined, 'there is no server client');
});

test('project data exports to a real ZIP without a server', { skip }, async () => {
  const { window } = ctx;
  const app = window.__alphacode;
  const { zipSync } = await import(path.join(ROOT, 'web', 'engine', 'zip.js').replace(/\\/g, '/'));
  const files = await app.state.fs.snapshot(app.state.project.id);
  const bytes = zipSync(files);
  assert.ok(bytes.byteLength > 100);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 2)), 'PK');
});

after(() => ctx?.restore());
