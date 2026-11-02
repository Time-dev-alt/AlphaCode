/**
 * A compact VT100/xterm-compatible terminal renderer (no dependencies).
 * Supports cursor addressing, SGR colour (16/256/truecolor), erase/insert/delete,
 * scroll regions, alternate screen, DEC private modes and device status reports —
 * enough for bash, vim, top, git, npm and other full-screen programs.
 */

const BASE16 = [
  '#0b0d12', '#f0646e', '#4fd68b', '#e8b661', '#63b3ff', '#a78bfa', '#5ad1e6', '#cdd3de',
  '#5c6370', '#ff8b93', '#7ce8ac', '#f5cf7a', '#8fc6ff', '#c4b0ff', '#8fe6f5', '#ffffff',
];

function rgbHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

function buildPalette() {
  const p = [...BASE16];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) p.push(rgbHex(steps[r], steps[g], steps[b]));
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(rgbHex(v, v, v));
  }
  return p;
}
const PALETTE = buildPalette();

const DEFAULT_ATTR = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false });

export class TerminalView {
  constructor(node, { cols = 100, rows = 30, onInput = () => {}, onResize = () => {}, onBell = () => {} } = {}) {
    this.node = node;
    this.cols = cols;
    this.rows = rows;
    this.onInput = onInput;
    this.onResize = onResize;
    this.onBell = onBell;
    this.screen = this.blankScreen();
    this.altScreen = null;
    this.cursor = { row: 0, col: 0 };
    this.saved = { row: 0, col: 0 };
    this.attr = { ...DEFAULT_ATTR };
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.scrollback = [];
    this.maxScrollback = 1200;
    this.evState = null;
    this.evBuf = '';
    this.wrapPending = false;
    this.cursorVisible = true;
    this.mouse = false;
    this.lastChar = ' ';
    this.dirty = false;
    this.stickToBottom = true;
    this.decoder = new TextDecoder();
    this._frame = null;
    this.bindInput();
    this.resize(cols, rows, false);
  }

  blankScreen() {
    return Array.from({ length: this.rows }, () => this.blankLine());
  }
  blankLine() {
    return Array.from({ length: this.cols }, () => ({ ch: ' ', ...DEFAULT_ATTR }));
  }

  resize(cols, rows, notify = true) {
    cols = Math.max(20, Math.floor(cols));
    rows = Math.max(4, Math.floor(rows));
    if (cols === this.cols && rows === this.rows) return;
    const oldScreen = this.screen;
    const newScreen = Array.from({ length: rows }, (_, r) => {
      const src = oldScreen[r];
      if (!src) return Array.from({ length: cols }, () => ({ ch: ' ', ...DEFAULT_ATTR }));
      if (cols <= src.length) return src.slice(0, cols);
      return [...src, ...Array.from({ length: cols - src.length }, () => ({ ch: ' ', ...DEFAULT_ATTR }))];
    });
    this.screen = newScreen;
    this.cols = cols;
    this.rows = rows;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.cursor.row = Math.min(this.cursor.row, rows - 1);
    this.cursor.col = Math.min(this.cursor.col, cols - 1);
    if (notify) this.onResize(cols, rows);
    this.render();
  }

  /* ------------------------------------------------------------- output --- */
  write(data) {
    const text = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const code = ch.charCodeAt(0);
      if (this.evState === 'osc') {
        if (ch === '\x07') this.evState = null;
        else if (ch === '\x1b') this.evState = 'osc-esc';
        continue;
      }
      if (this.evState === 'osc-esc') {
        this.evState = ch === '\\' ? null : 'osc';
        continue;
      }
      if (this.evState === 'esc') {
        this.handleEsc(ch);
        continue;
      }
      if (this.evState === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          this.handleCsi(this.evBuf, ch);
          this.evBuf = '';
          this.evState = null;
        } else if (this.evBuf.length < 64) this.evBuf += ch;
        continue;
      }
      if (this.evState === 'charset') {
        this.evState = null;
        continue;
      }
      if (ch === '\x1b') {
        this.evState = 'esc';
        this.evBuf = '';
        continue;
      }
      if (code === 0x9b) {
        this.evState = 'csi';
        this.evBuf = '';
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        this.control(code);
        continue;
      }
      this.print(ch);
    }
    this.scheduleRender();
  }

  control(code) {
    switch (code) {
      case 0x07:
        this.onBell();
        break;
      case 0x08:
        this.wrapPending = false;
        this.cursor.col = Math.max(0, this.cursor.col - 1);
        break;
      case 0x09: {
        const next = Math.min(this.cols - 1, (Math.floor(this.cursor.col / 8) + 1) * 8);
        this.cursor.col = next;
        break;
      }
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.lineFeed();
        break;
      case 0x0d:
        this.cursor.col = 0;
        this.wrapPending = false;
        break;
      default:
        break;
    }
  }

  print(ch) {
    if (this.wrapPending) {
      this.cursor.col = 0;
      this.lineFeed();
      this.wrapPending = false;
    }
    const row = this.screen[this.cursor.row];
    if (!row) return;
    row[this.cursor.col] = { ch, ...this.attr };
    this.lastChar = ch;
    if (this.cursor.col >= this.cols - 1) {
      this.cursor.col = this.cols - 1;
      this.wrapPending = true;
    } else {
      this.cursor.col++;
    }
  }

  lineFeed() {
    this.wrapPending = false;
    if (this.cursor.row === this.scrollBottom) this.scrollUp(1);
    else if (this.cursor.row < this.rows - 1) this.cursor.row++;
  }

  scrollUp(n = 1) {
    for (let i = 0; i < n; i++) {
      if (this.scrollTop === 0 && this.scrollBottom === this.rows - 1 && !this.altScreen) {
        this.scrollback.push(this.screen[this.scrollTop]);
        if (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
      }
      for (let r = this.scrollTop; r < this.scrollBottom; r++) this.screen[r] = this.screen[r + 1];
      this.screen[this.scrollBottom] = this.blankLine();
    }
  }

  scrollDown(n = 1) {
    for (let i = 0; i < n; i++) {
      for (let r = this.scrollBottom; r > this.scrollTop; r--) this.screen[r] = this.screen[r - 1];
      this.screen[this.scrollTop] = this.blankLine();
    }
  }

  /* --------------------------------------------------------- sequences --- */
  handleEsc(ch) {
    this.evState = null;
    switch (ch) {
      case '[':
        this.evState = 'csi';
        this.evBuf = '';
        break;
      case ']':
        this.evState = 'osc';
        break;
      case '(':
      case ')':
      case '*':
      case '+':
        this.evState = 'charset';
        break;
      case '7':
        this.saved = { ...this.cursor };
        break;
      case '8':
        this.cursor = { ...this.saved };
        break;
      case 'D':
        this.lineFeed();
        break;
      case 'M':
        if (this.cursor.row === this.scrollTop) this.scrollDown(1);
        else this.cursor.row = Math.max(0, this.cursor.row - 1);
        break;
      case 'E':
        this.cursor.col = 0;
        this.lineFeed();
        break;
      case 'c':
        this.reset();
        break;
      default:
        break;
    }
  }

  handleCsi(buf, final) {
    let priv = '';
    let body = buf;
    if (/^[?>=!]/.test(body)) {
      priv = body[0];
      body = body.slice(1);
    }
    const parts = body.split(';');
    const nums = parts.map((p) => (p === '' ? 0 : Number.parseInt(p, 10) || 0));
    const n = nums[0] || 0;
    const count = n === 0 ? 1 : n;

    switch (final) {
      case 'A':
        this.cursor.row = Math.max(this.scrollTop, this.cursor.row - count);
        break;
      case 'B':
        this.cursor.row = Math.min(this.rows - 1, this.cursor.row + count);
        break;
      case 'C':
        this.cursor.col = Math.min(this.cols - 1, this.cursor.col + count);
        break;
      case 'D':
        this.cursor.col = Math.max(0, this.cursor.col - count);
        break;
      case 'E':
        this.cursor.row = Math.min(this.rows - 1, this.cursor.row + count);
        this.cursor.col = 0;
        break;
      case 'F':
        this.cursor.row = Math.max(0, this.cursor.row - count);
        this.cursor.col = 0;
        break;
      case 'G':
      case '`':
        this.cursor.col = Math.max(0, Math.min(this.cols - 1, (nums[0] || 1) - 1));
        break;
      case 'H':
      case 'f': {
        const row = (nums[0] || 1) - 1;
        const col = (nums[1] || 1) - 1;
        this.cursor.row = Math.max(0, Math.min(this.rows - 1, row));
        this.cursor.col = Math.max(0, Math.min(this.cols - 1, col));
        break;
      }
      case 'd':
        this.cursor.row = Math.max(0, Math.min(this.rows - 1, (nums[0] || 1) - 1));
        break;
      case 'J':
        this.eraseDisplay(n);
        break;
      case 'K':
        this.eraseLine(n);
        break;
      case 'L':
        for (let i = 0; i < count; i++) {
          for (let r = this.scrollBottom; r > this.cursor.row; r--) this.screen[r] = this.screen[r - 1];
          this.screen[this.cursor.row] = this.blankLine();
        }
        break;
      case 'M':
        for (let i = 0; i < count; i++) {
          for (let r = this.cursor.row; r < this.scrollBottom; r++) this.screen[r] = this.screen[r + 1];
          this.screen[this.scrollBottom] = this.blankLine();
        }
        break;
      case 'P': {
        const row = this.screen[this.cursor.row];
        row.splice(this.cursor.col, count);
        while (row.length < this.cols) row.push({ ch: ' ', ...DEFAULT_ATTR });
        break;
      }
      case '@': {
        const row = this.screen[this.cursor.row];
        row.splice(this.cursor.col, 0, ...Array.from({ length: count }, () => ({ ch: ' ', ...DEFAULT_ATTR })));
        row.length = this.cols;
        break;
      }
      case 'X': {
        const row = this.screen[this.cursor.row];
        for (let i = 0; i < count && this.cursor.col + i < this.cols; i++) row[this.cursor.col + i] = { ch: ' ', ...DEFAULT_ATTR };
        break;
      }
      case 'S':
        this.scrollUp(count);
        break;
      case 'T':
        this.scrollDown(count);
        break;
      case 'm':
        this.sgr(nums, parts);
        break;
      case 'r': {
        this.scrollTop = Math.max(0, (nums[0] || 1) - 1);
        this.scrollBottom = Math.min(this.rows - 1, (nums[1] || this.rows) - 1);
        this.cursor.row = 0;
        this.cursor.col = 0;
        break;
      }
      case 's':
        this.saved = { ...this.cursor };
        break;
      case 'u':
        this.cursor = { ...this.saved };
        break;
      case 'n':
        if (nums[0] === 6) this.onInput(`\x1b[${this.cursor.row + 1};${this.cursor.col + 1}R`);
        else if (nums[0] === 5) this.onInput('\x1b[0n');
        break;
      case 'h':
        this.setModes(nums, true, priv);
        break;
      case 'l':
        this.setModes(nums, false, priv);
        break;
      case 'b':
        for (let i = 0; i < count; i++) this.print(this.lastChar);
        break;
      case 'c':
        if (nums[0] === 0 || nums[0] === undefined) this.onInput('\x1b[?62;22c');
        break;
      default:
        break;
    }
    if (final !== 'm' && final !== 'h' && final !== 'l') this.wrapPending = false;
  }

  setModes(nums, on, priv) {
    for (const mode of nums) {
      if (priv === '?') {
        if (mode === 25) this.cursorVisible = on;
        else if (mode === 1049 || mode === 47 || mode === 1047) {
          if (on) this.enterAltScreen();
          else this.exitAltScreen();
        } else if (mode === 1000 || mode === 1002 || mode === 1003 || mode === 1006) this.mouse = on;
      }
      if (mode === 4) this.insertMode = on;
    }
  }

  enterAltScreen() {
    if (this.altScreen) return;
    this.altScreen = { screen: this.screen, cursor: { ...this.cursor } };
    this.screen = Array.from({ length: this.rows }, () => this.blankLine());
    this.cursor = { row: 0, col: 0 };
  }
  exitAltScreen() {
    if (!this.altScreen) return;
    this.screen = this.altScreen.screen;
    this.cursor = this.altScreen.cursor;
    this.altScreen = null;
  }

  eraseDisplay(mode) {
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.cursor.row + 1; r < this.rows; r++) this.screen[r] = this.blankLine();
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let r = 0; r < this.cursor.row; r++) this.screen[r] = this.blankLine();
    } else {
      for (let r = 0; r < this.rows; r++) this.screen[r] = this.blankLine();
    }
  }

  eraseLine(mode) {
    const row = this.screen[this.cursor.row];
    if (!row) return;
    if (mode === 0) for (let c = this.cursor.col; c < this.cols; c++) row[c] = { ch: ' ', ...DEFAULT_ATTR };
    else if (mode === 1) for (let c = 0; c <= this.cursor.col; c++) row[c] = { ch: ' ', ...DEFAULT_ATTR };
    else for (let c = 0; c < this.cols; c++) row[c] = { ch: ' ', ...DEFAULT_ATTR };
  }

  sgr(nums, rawParts) {
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      if (n === 0) this.attr = { ...DEFAULT_ATTR };
      else if (n === 1) this.attr.bold = true;
      else if (n === 2) this.attr.dim = true;
      else if (n === 3) this.attr.italic = true;
      else if (n === 4) this.attr.underline = true;
      else if (n === 7) this.attr.inverse = true;
      else if (n === 9) this.attr.strike = true;
      else if (n === 22) {
        this.attr.bold = false;
        this.attr.dim = false;
      } else if (n === 23) this.attr.italic = false;
      else if (n === 24) this.attr.underline = false;
      else if (n === 27) this.attr.inverse = false;
      else if (n === 29) this.attr.strike = false;
      else if (n >= 30 && n <= 37) this.attr.fg = PALETTE[n - 30];
      else if (n === 39) this.attr.fg = null;
      else if (n >= 40 && n <= 47) this.attr.bg = PALETTE[n - 40];
      else if (n === 49) this.attr.bg = null;
      else if (n >= 90 && n <= 97) this.attr.fg = PALETTE[n - 90 + 8];
      else if (n >= 100 && n <= 107) this.attr.bg = PALETTE[n - 100 + 8];
      else if (n === 38 || n === 48) {
        const target = n === 38 ? 'fg' : 'bg';
        if (nums[i + 1] === 5) {
          this.attr[target] = PALETTE[nums[i + 2]] || null;
          i += 2;
        } else if (nums[i + 1] === 2) {
          this.attr[target] = rgbHex(nums[i + 2] || 0, nums[i + 3] || 0, nums[i + 4] || 0);
          i += 4;
        }
      }
    }
  }

  reset() {
    this.attr = { ...DEFAULT_ATTR };
    this.screen = Array.from({ length: this.rows }, () => this.blankLine());
    this.cursor = { row: 0, col: 0 };
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.wrapPending = false;
    this.scrollback = [];
  }

  clear() {
    this.reset();
    this.render();
  }

  /* -------------------------------------------------------------- render -- */
  scheduleRender() {
    if (this.dirty) return;
    this.dirty = true;
    this._frame = requestAnimationFrame(() => {
      this.dirty = false;
      this.render();
    });
  }

  cellHtml(cell, isCursor) {
    const text = cell.ch === ' ' && isCursor ? ' ' : escapeCell(cell.ch);
    const styles = [];
    let fg = cell.fg;
    let bg = cell.bg;
    if (cell.inverse) [fg, bg] = [bg || '#0b0d12', fg || '#cdd3de'];
    if (fg) styles.push(`color:${fg}`);
    if (bg) styles.push(`background:${bg}`);
    if (cell.bold) styles.push('font-weight:700');
    if (cell.dim) styles.push('opacity:.62');
    if (cell.italic) styles.push('font-style:italic');
    if (cell.underline) styles.push('text-decoration:underline');
    if (cell.strike) styles.push('text-decoration:line-through');
    if (isCursor) styles.push('outline:1px solid rgba(242,133,79,.75)');
    const style = styles.length ? ` style="${styles.join(';')}"` : '';
    return `<span class="${isCursor ? 'cursor' : ''}"${style}>${text}</span>`;
  }

  render() {
    if (!this.node) return;
    const nearBottom = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 40;
    const parts = [];
    const sb = this.scrollback.slice(-400);
    for (const row of sb) parts.push(`<div class="row sb">${this.renderRow(row, -1, -1)}</div>`);
    for (let r = 0; r < this.rows; r++) {
      const isCursorRow = r === this.cursor.row && this.cursorVisible && !this.altScreenHidden;
      parts.push(`<div class="row">${this.renderRow(this.screen[r], isCursorRow ? this.cursor.col : -1, r)}</div>`);
    }
    (this.canvas || this.node).innerHTML = parts.join('');
    if (nearBottom || this.stickToBottom) this.node.scrollTop = this.node.scrollHeight;
  }

  renderRow(row, cursorCol) {
    if (!row) return '';
    let html = '';
    let run = '';
    let runStyle = null;
    const flush = () => {
      if (run) {
        html += runStyle ? `<span style="${runStyle}">${escapeCell(run)}</span>` : escapeCell(run);
        run = '';
        runStyle = null;
      }
    };
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const isCursor = c === cursorCol;
      if (isCursor) {
        flush();
        html += this.cellHtml(cell, true);
        continue;
      }
      const style = `color:${cell.fg || ''};background:${cell.bg || ''};${cell.bold ? 'font-weight:700;' : ''}${cell.dim ? 'opacity:.62;' : ''}${cell.italic ? 'font-style:italic;' : ''}${cell.underline ? 'text-decoration:underline;' : ''}`;
      if (runStyle === null) runStyle = style;
      if (style !== runStyle) {
        flush();
        runStyle = style;
      }
      run += cell.ch;
    }
    flush();
    return html;
  }

  /* --------------------------------------------------------------- input -- */
  /*
   * Input goes through a pinned 1px textarea, not the keydown of the host div.
   *
   * Why: a div cannot take focus (no tabindex, and `.focus()` on it is a no-op),
   * and on phones the `keydown` event often reports keyCode 229 for real
   * characters — so keyboard input silently vanished. A textarea that never moves
   * fixes both: it can be focused, it fires `input` for every character an IME or
   * a predictive keyboard produces, and because it sits at the top-left corner it
   * never gets scrolled out of view when the on-screen keyboard opens.
   *
   * A single space is kept in the box as a sentinel so Backspace always has
   * something to delete; every input event is diffed against it and the box is
   * reset immediately.
   */
  bindInput() {
    const doc = this.node.ownerDocument || globalThis.document;
    // The screen model works without a DOM (tests, offscreen use). Only the
    // caret box needs one, so skip it rather than crash.
    if (!doc?.createElement) {
      this.resetInput = () => {};
      return;
    }
    if (this.input) this.input.remove();
    const ta = doc.createElement('textarea');
    ta.className = 'term-input';
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('aria-label', 'Terminal input');
    ta.setAttribute('rows', '1');
    ta.style.cssText =
      'position:absolute;top:0;left:0;width:1px;height:1px;padding:0;margin:0;border:0;opacity:0;' +
      'resize:none;overflow:hidden;background:transparent;color:transparent;caret-color:transparent;' +
      'font-size:16px;z-index:2;';
    if (typeof getComputedStyle === 'function' && getComputedStyle(this.node).position === 'static') {
      this.node.style.position = 'relative';
    }
    this.input = ta;
    // Repaints own the canvas, not the host: `innerHTML` on the host would wipe
    // the caret box and blur it, dropping every keystroke after the first.
    const canvas = doc.createElement('div');
    canvas.className = 'term-canvas';
    this.canvas = canvas;
    this.node.append(canvas, ta);
    this.sentinel = ' ';

    const reset = () => {
      ta.value = this.sentinel;
      try {
        ta.setSelectionRange(1, 1);
      } catch {
        /* older engines */
      }
    };
    this.resetInput = reset;
    reset();

    // Every character, including IME composition and predictive keyboards.
    ta.addEventListener('input', () => {
      if (this.composing) return;
      const value = ta.value;
      if (value === this.sentinel) return;
      const typed = value.replace(this.sentinel, '').replace(/\n/g, '\r');
      reset();
      if (typed) this.onInput(typed);
      else this.onInput('\x7f');
    });
    ta.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    ta.addEventListener('compositionend', (event) => {
      this.composing = false;
      const typed = String(event.data || '').replace(/\n/g, '\r');
      reset();
      if (typed) this.onInput(typed);
    });

    ta.addEventListener('keydown', (e) => {
      // Copy keeps the browser behaviour when there is a selection to copy.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && String(doc.getSelection() || '')) return;
      // Paste, cut and select-all are handled by their own events.
      if ((e.metaKey || e.ctrlKey) && ['v', 'x', 'a'].includes(e.key.toLowerCase())) return;

      let seq = '';
      const k = e.key;
      if (e.ctrlKey && !e.metaKey) {
        if (k.length === 1) {
          const code = k.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) seq = String.fromCharCode(code - 64);
        }
        if (k === ' ') seq = '\x00';
        if (k === '[') seq = '\x1b';
        if (k === '\\') seq = '\x1c';
      } else if (e.altKey && k.length === 1) {
        seq = '\x1b' + k;
      } else {
        switch (k) {
          case 'Enter':
            seq = '\r';
            break;
          case 'Backspace':
            seq = '\x7f';
            break;
          case 'Tab':
            seq = e.shiftKey ? '\x1b[Z' : '\t';
            break;
          case 'Escape':
            seq = '\x1b';
            break;
          case 'ArrowUp':
            seq = '\x1b[A';
            break;
          case 'ArrowDown':
            seq = '\x1b[B';
            break;
          case 'ArrowRight':
            seq = '\x1b[C';
            break;
          case 'ArrowLeft':
            seq = '\x1b[D';
            break;
          case 'Home':
            seq = '\x1b[H';
            break;
          case 'End':
            seq = '\x1b[F';
            break;
          case 'PageUp':
            seq = '\x1b[5~';
            break;
          case 'PageDown':
            seq = '\x1b[6~';
            break;
          case 'Delete':
            seq = '\x1b[3~';
            break;
          default:
            // Printable keys arrive through the `input` event instead, so they are
            // never sent twice and IME input works.
            if (/^F\d{1,2}$/.test(k)) {
              const n = Number(k.slice(1));
              const fkeys = { 1: '\x1bOP', 2: '\x1bOQ', 3: '\x1bOR', 4: '\x1bOS', 5: '\x1b[15~', 6: '\x1b[17~', 7: '\x1b[18~', 8: '\x1b[19~', 9: '\x1b[20~', 10: '\x1b[21~', 11: '\x1b[23~', 12: '\x1b[24~' };
              seq = fkeys[n] || '';
            }
        }
      }

      if (seq) {
        e.preventDefault();
        reset();
        this.onInput(seq);
      }
      // Keep the caret box alive even if something stole focus.
      if (doc.activeElement !== ta && seq) ta.focus({ preventScroll: true });
    });

    ta.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      e.preventDefault();
      reset();
      this.onInput(text.replace(/\r?\n/g, '\r'));
    });

    this.node.addEventListener('mousedown', (e) => {
      if (e.target === ta) return;
      const selection = String(doc.getSelection() || '');
      if (selection) return; // let the user select text to copy
      e.preventDefault();
      this.focus();
    });
    this.node.addEventListener('scroll', () => {
      this.stickToBottom = this.node.scrollHeight - this.node.scrollTop - this.node.clientHeight < 40;
    });
  }

  /** Send a string as if it had been typed (used by the on-screen key bar). */
  send(text) {
    this.resetInput?.();
    this.onInput(text);
  }

  focus() {
    try {
      this.input?.focus({ preventScroll: true });
    } catch {
      this.node.focus?.();
    }
  }

  blur() {
    this.input?.blur();
  }

  scrollToBottom() {
    this.stickToBottom = true;
    this.node.scrollTop = this.node.scrollHeight;
  }

  measure() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:inherit;font-size:inherit;line-height:inherit';
    probe.textContent = 'M'.repeat(20);
    this.node.append(probe);
    const charW = probe.getBoundingClientRect().width / 20 || 7.2;
    const rowH = probe.getBoundingClientRect().height || 17;
    probe.remove();
    const rect = this.node.getBoundingClientRect();
    const cols = Math.max(20, Math.floor((rect.width - 8) / charW));
    const rows = Math.max(4, Math.floor((rect.height - 4) / rowH));
    return { cols, rows };
  }

  fit() {
    const { cols, rows } = this.measure();
    if (cols !== this.cols || rows !== this.rows) this.resize(cols, rows);
  }
}

function escapeCell(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
}
