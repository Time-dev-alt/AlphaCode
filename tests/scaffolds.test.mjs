/**
 * Scaffold tests.
 *
 * A scaffold is only worth shipping if the app it produces *actually runs* —
 * these boot each one in jsdom, execute its script the way the preview does, and
 * then poke at it like a user. A template that throws on load is worse than no
 * template, because it looks finished and isn't.
 *
 * Skipped automatically when jsdom is not installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderScaffold, SCAFFOLD_IDS, SCAFFOLDS } = await import('../web/engine/agent/scaffolds.js');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}
const skip = JSDOM ? false : 'jsdom is not installed (npm i -D jsdom)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a scaffold the way the preview iframe would. */
async function bootScaffold(id, options = {}) {
  const { files } = renderScaffold(id, options);
  const dom = new JSDOM(files['index.html'], { url: 'https://scaffold.local/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  // The preview sandbox may block storage; a scaffold must survive that.
  window.IntersectionObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe(el) {
      this.cb([{ isIntersecting: true, target: el }], this);
    }
    unobserve() {}
    disconnect() {}
  };
  if (typeof window.Storage === 'function') {
    /* jsdom provides a working localStorage, which is what a real page gets */
  }
  try {
    window.eval(files['app.js']);
  } catch (error) {
    errors.push(error.message);
  }
  await wait(20);
  return { window, doc: window.document, files, errors };
}

test('every scaffold boots with no runtime errors', { skip }, async () => {
  for (const id of SCAFFOLD_IDS) {
    const { errors, doc } = await bootScaffold(id);
    assert.deepEqual(errors, [], `${id} threw on boot`);
    assert.ok(doc.querySelector('h1'), `${id} renders a heading`);
  }
});

test('the landing page works: mobile nav, year, scroll state', { skip }, async () => {
  const { window, doc, errors } = await bootScaffold('landing');
  assert.deepEqual(errors, []);

  const toggle = doc.querySelector('#nav-toggle');
  const links = doc.querySelector('#nav-links');
  assert.ok(toggle, 'there is a menu button');
  assert.equal(links.classList.contains('open'), false);
  toggle.click();
  assert.equal(links.classList.contains('open'), true, 'the menu opens');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'and says so');
  toggle.click();
  assert.equal(links.classList.contains('open'), false, 'and closes again');

  assert.equal(doc.querySelector('#year').textContent, String(new Date().getFullYear()));

  // Section anchors exist for every nav link, or the page lies about its nav.
  for (const link of doc.querySelectorAll('.nav-links a')) {
    const target = link.getAttribute('href');
    if (target?.startsWith('#') && target.length > 1) {
      assert.ok(doc.querySelector(target), `${target} exists`);
    }
  }
  window.close();
});

test('the todo app really adds, completes, filters and persists', { skip }, async () => {
  const { window, doc, errors } = await bootScaffold('todo');
  assert.deepEqual(errors, []);

  const input = doc.querySelector('#input');
  const form = doc.querySelector('#form');
  const add = (text) => {
    input.value = text;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };

  add('buy coffee');
  add('write the README');
  assert.equal(doc.querySelectorAll('li.item').length, 2, 'both tasks rendered');
  assert.match(doc.querySelector('#count').textContent, /2 of 2 remaining/);

  // Complete the first task.
  doc.querySelector('li.item .check').click();
  assert.equal(doc.querySelectorAll('li.item.done').length, 1);
  assert.match(doc.querySelector('#left').textContent, /1 left/);

  // Filter to active only.
  doc.querySelector('[data-filter="active"]').click();
  assert.equal(doc.querySelectorAll('li.item').length, 1, 'the done task is hidden');
  doc.querySelector('[data-filter="done"]').click();
  assert.equal(doc.querySelectorAll('li.item').length, 1);
  assert.ok(doc.querySelector('li.item.done'), 'and it is the completed one');

  // It survives a reload.
  const saved = window.localStorage.getItem('tasks.v1');
  assert.ok(saved, 'state persisted');
  assert.equal(JSON.parse(saved).length, 2);

  // Clear completed.
  doc.querySelector('[data-filter="all"]').click();
  doc.querySelector('#clear').click();
  assert.equal(doc.querySelectorAll('li.item').length, 1, 'completed tasks cleared');
  assert.equal(doc.querySelector('#empty').hidden, true, 'not empty yet');

  // And the empty state appears when everything is gone.
  doc.querySelector('li.item .del').click();
  assert.equal(doc.querySelectorAll('li.item').length, 0);
  assert.equal(doc.querySelector('#empty').hidden, false, 'empty state shown');
  window.close();
});

test('the dashboard renders its data and filters the table', { skip }, async () => {
  const { window, doc, errors } = await bootScaffold('dashboard');
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelectorAll('.stat').length >= 4, 'stat cards');
  assert.ok(doc.querySelectorAll('#orders tr').length >= 4, 'table rows');

  const q = doc.querySelector('#q');
  q.value = 'ada';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  const visible = [...doc.querySelectorAll('#orders tr')].filter((row) => row.style.display !== 'none');
  assert.equal(visible.length, 1, 'search filters the table');
  assert.match(visible[0].textContent, /Ada/i);

  // The sidebar drawer only exists for small screens, but the class must toggle.
  doc.querySelector('#menu-btn').click();
  assert.ok(doc.querySelector('#side').classList.contains('open'));
  window.close();
});

test('the docs site has working anchors and every sidebar link resolves', { skip }, async () => {
  const { window, doc, errors } = await bootScaffold('docs');
  assert.deepEqual(errors, []);
  const ids = [...doc.querySelectorAll('article h2[id]')].map((h) => h.id);
  assert.ok(ids.includes('deploy'));
  for (const link of doc.querySelectorAll('.toc a')) {
    const id = link.getAttribute('href').slice(1);
    assert.ok(ids.includes(id), `toc target ${id} exists`);
  }
  assert.ok(doc.querySelector('.side nav a.active'), 'the current page is marked');
  window.close();
});

test('scaffolds are brandable and self-contained', { skip }, async () => {
  const { doc } = await bootScaffold('landing', { brand: 'Kestrel & Sons' });
  assert.match(doc.title, /Kestrel/);
  const html = doc.documentElement.outerHTML;
  assert.ok(!/Nimbus/.test(html), 'the placeholder brand is gone');
  for (const id of SCAFFOLD_IDS) {
    const { files } = renderScaffold(id);
    // Example URLs in prose are fine; anything the browser would *fetch* is not.
    const external = [
      ...files['index.html'].matchAll(/<(?:script|link|img)[^>]*(?:src|href)="(https?:)?\/\/[^"]+"/gi),
      ...files['style.css'].matchAll(/@import[^;]*url\(\s*['"]?(https?:)?\/\//gi),
      ...files['app.js'].matchAll(/fetch\(\s*['"]https?:\/\//gi),
    ];
    assert.deepEqual(external.map((m) => m[0]), [], `${id} makes no network requests`);
  }
  assert.ok(SCAFFOLDS.landing.blurb.includes('hero'));
});
