/**
 * Browser-module tests without a browser: import the real client modules
 * (catching TDZ/import-time crashes) and drive the terminal emulator with a
 * fake DOM node, asserting screen state for ANSI sequences.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { TerminalView } = await import('../public/assets/term.js');
const util = await import('../public/assets/util.js');

function fakeNode() {
  return {
    children: [],
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 300,
    style: {},
    classes: new Set(),
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    append(child) {
      this.children.push(child);
    },
    getBoundingClientRect() {
      return { width: 800, height: 480, top: 0, left: 0 };
    },
    ownerDocument: { getSelection: () => null },
  };
}

function makeView(cols = 40, rows = 8) {
  const node = fakeNode();
  const view = new TerminalView(node, { cols, rows, onInput: () => {}, onResize: () => {} });
  view.render = () => {}; // rendering needs layout; we assert on the buffer instead
  return { view, node };
}

const lineText = (view, row) =>
  view.screen[row]
    .map((c) => c.ch)
    .join('')
    .replace(/\s+$/, '');

test('client modules import without crashing', () => {
  assert.equal(typeof util.md, 'function');
  assert.equal(typeof util.icon, 'function');
  assert.equal(typeof util.highlight, 'function');
  assert.equal(typeof TerminalView, 'function');
});

test('writes text and advances the cursor', () => {
  const { view } = makeView();
  view.write('hello world');
  assert.equal(lineText(view, 0), 'hello world');
  assert.equal(view.cursor.col, 11);
});

test('handles CR/LF and deferred wrapping', () => {
  const { view } = makeView(20, 4);
  view.write('12345678901234567890'); // exactly one row
  assert.equal(lineText(view, 0), '12345678901234567890');
  assert.equal(view.wrapPending, true, 'wrap is deferred until the next glyph');
  view.write('X');
  assert.equal(lineText(view, 1), 'X');
  view.write('\r\nnext');
  assert.equal(lineText(view, 2), 'next');
  assert.equal(view.cursor.col, 4);
});

test('clamps the grid to a usable minimum', () => {
  const { view } = makeView(3, 1);
  assert.equal(view.cols, 20);
  assert.equal(view.rows, 4);
});

test('cursor addressing and erase-line work', () => {
  const { view } = makeView(20, 5);
  view.write('aaaa\r\nbbbb\r\ncccc');
  view.write('\x1b[2;3H'); // row 2 col 3
  view.write('ZZ');
  assert.equal(lineText(view, 1), 'bbZZ');
  view.write('\x1b[2K'); // erase whole line
  assert.equal(lineText(view, 1), '');
  view.write('\x1b[H'); // home
  view.write('\x1b[K'); // erase to end of line
  assert.equal(lineText(view, 0), '');
});

test('SGR colours are parsed (16, 256 and truecolour)', () => {
  const { view } = makeView(20, 3);
  view.write('\x1b[31mred\x1b[0m');
  assert.equal(view.screen[0][0].fg, '#f0646e');
  view.write('\x1b[38;5;208morange');
  assert.match(view.screen[0][3].fg, /^#[0-9a-f]{6}$/);
  view.write('\x1b[38;2;1;2;3mtrue');
  assert.equal(view.screen[0][9].fg, '#010203');
  view.write('\x1b[1;4mbold');
  assert.equal(view.screen[0][13].bold, true);
  assert.equal(view.screen[0][13].underline, true);
});

test('scrolling keeps a scrollback buffer', () => {
  const { view } = makeView(20, 4);
  view.write('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix');
  assert.equal(view.scrollback.length, 2, 'oldest lines moved to scrollback');
  assert.equal(
    view.scrollback.map((row) => row.map((c) => c.ch).join('').trim()).join(','),
    'one,two',
  );
  assert.equal(lineText(view, 3), 'six');
  view.write('\r\nseven\r\neight');
  assert.ok(view.scrollback.length >= 4);
  assert.ok(view.scrollback.length <= view.maxScrollback);
});

test('alternate screen is entered and restored (vim/top)', () => {
  const { view } = makeView(20, 4);
  view.write('main screen');
  view.write('\x1b[?1049h');
  assert.equal(lineText(view, 0), '');
  view.write('fullscreen app');
  assert.equal(lineText(view, 0), 'fullscreen app');
  view.write('\x1b[?1049l');
  assert.equal(lineText(view, 0), 'main screen');
});

test('device status report replies with the cursor position', () => {
  let reply = '';
  const node = fakeNode();
  const view = new TerminalView(node, { cols: 20, rows: 5, onInput: (d) => (reply = d) });
  view.render = () => {};
  view.write('ab\x1b[6n');
  assert.equal(reply, '\x1b[1;3R');
});

test('resize preserves content and clamps the cursor', () => {
  let notified = null;
  const node = fakeNode();
  const view = new TerminalView(node, { cols: 40, rows: 8, onResize: (c, r) => (notified = [c, r]) });
  view.render = () => {};
  view.write('keep me\r\nand this');
  view.resize(20, 4);
  assert.equal(view.cols, 20);
  assert.equal(view.rows, 4);
  assert.equal(lineText(view, 0), 'keep me');
  assert.equal(lineText(view, 1), 'and this');
  assert.ok(view.cursor.row < 4);
  assert.deepEqual(notified, [20, 4], 'resize notifies the server');
  assert.equal(view.screen[0].length, 20);
  // shrinking then growing must not leave ragged rows
  view.resize(60, 10);
  assert.ok(view.screen.every((row) => row.length === 60));
});

test('markdown renderer escapes HTML and highlights code', () => {
  const html = util.md('# Title\n\n<script>alert(1)</script>\n\n```js\nconst a = 1;\n```\n\n- one\n- two');
  assert.ok(!html.includes('<script>'), 'raw HTML must be escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /tok-key/);
  assert.match(html, /<li>one<\/li>/);
});

test('markdown links are restricted to http(s)', () => {
  const html = util.md('[x](javascript:alert(1)) [y](https://example.com)');
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /href="https:\/\/example.com"/);
});

test('diff renderer classifies lines', () => {
  const html = util.renderDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n context');
  assert.match(html, /class="del"/);
  assert.match(html, /class="add"/);
  assert.match(html, /class="hunk"/);
});
