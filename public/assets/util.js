/* Shared UI helpers: DOM, icons, markdown, diffs, toasts. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ICONS = {
  menu: 'M3 6h18M3 12h18M3 18h18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M20 6L9 17l-5-5',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.7 9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  command: 'M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z',
  chat: 'M21 11.5a8.4 8.4 0 01-9 8.5 9.9 9.9 0 01-4.4-1L3 21l1.9-4.4A8.4 8.4 0 012 11.5 8.5 8.5 0 0111 3a8.5 8.5 0 0110 8.5z',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  database: 'M12 7c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3z M20 12c0 1.7-3.6 3-8 3s-8-1.3-8-3 M20 5v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5',
  rocket: 'M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8-.8-.7-2-.7-3 .8z M12 15l-3-3c.5-4 2-7 5-9 2.5-1.6 6-2 6-2s-.4 3.5-2 6c-2 3-5 4.5-9 5z M9 12l-4-1 2-3 3 1 M12 15l1 4 3-2-1-3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  gauge: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 12l4-4',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  stop: 'M6 6h12v12H6z',
  paperclip: 'M21.4 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  package: 'M21 16V8a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z M3.3 7L12 12l8.7-5M12 22V12',
  copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2z M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6',
  trash: 'M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
  external: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.8 7.8 5.5 5.5 0 017.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.3-4.3',
  play: 'M5 3l14 9-14 9V3z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  git: 'M12 22a10 10 0 100-20 10 10 0 000 20z M12 8v8M8 12h8',
  brain: 'M9.5 2A2.5 2.5 0 0112 4.5v15a2.5 2.5 0 01-4.96.44 2.5 2.5 0 01-2.96-3.1 3 3 0 01-.34-5.58 2.5 2.5 0 011.32-4.24A2.5 2.5 0 019.5 2z M14.5 2A2.5 2.5 0 0012 4.5v15a2.5 2.5 0 004.96.44 2.5 2.5 0 002.96-3.1 3 3 0 00.34-5.58 2.5 2.5 0 00-1.32-4.24A2.5 2.5 0 0014.5 2z',
  globe: 'M12 22a10 10 0 100-20 10 10 0 000 20z M2 12h20M12 2a15 15 0 010 20 15 15 0 010-20z',
  wifi: 'M5 12.55a11 11 0 0114 0M8.5 16.1a6 6 0 017 0M12 20h.01M1.4 9a16 16 0 0121.2 0',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20z M12 6v6l4 2',
};

export function icon(name, size = 16) {
  const d = ICONS[name] || ICONS.file;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d
    .split(/(?=M)/)
    .filter(Boolean)
    .map((seg) => `<path d="${seg.trim()}"/>`)
    .join('')}</svg>`;
}

export function paintIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    if (node.dataset.iconPainted) continue;
    node.innerHTML = icon(node.dataset.icon);
    node.dataset.iconPainted = '1';
  }
}

export function toast(message, kind = '', ms = 3800) {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}` });
  node.innerHTML = `${icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'wifi', 15)}<span>${escapeHtml(message)}</span>`;
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = '.2s';
    setTimeout(() => node.remove(), 220);
  }, ms);
}

export function modal({ title, body, footer, wide = false, onClose, closable = true }) {
  const root = $('#modal-root');
  const bg = el('div', { class: 'modal-bg' });
  const box = el('div', { class: `modal ${wide ? 'wide' : ''}` });
  const head = el('div', { class: 'modal-h' });
  head.innerHTML = `<h2>${escapeHtml(title || '')}</h2>`;
  if (closable) {
    const close = el('button', { class: 'icon-btn', title: 'Close', html: icon('x') });
    head.append(close);
    close.onclick = () => destroy();
  }
  const bodyEl = el('div', { class: 'modal-b' });
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  const footerEl = el('div', { class: 'modal-f' });
  if (footer) {
    if (typeof footer === 'string') footerEl.innerHTML = footer;
    else footerEl.append(footer);
  }
  box.append(head, bodyEl);
  if (footer) box.append(footerEl);
  bg.append(box);
  root.append(bg);
  paintIcons(box);
  function destroy() {
    bg.remove();
    onClose?.();
  }
  bg.addEventListener('mousedown', (e) => {
    if (e.target === bg && closable) destroy();
  });
  const onKey = (e) => {
    if (e.key === 'Escape' && closable) {
      destroy();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
  return { root: bg, body: bodyEl, footer: footerEl, close: destroy };
}

export function confirmDialog(message, { danger = false, confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    const footer = el('div', { class: 'field row' });
    const cancel = el('button', { class: 'btn', text: 'Cancel' });
    const ok = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: confirmLabel });
    footer.append(cancel, ok);
    const m = modal({ title: 'Confirm', body: el('p', { class: 'md', html: escapeHtml(message) }), footer, onClose: () => resolve(false) });
    cancel.onclick = () => {
      m.close();
      resolve(false);
    };
    ok.onclick = () => {
      m.close();
      resolve(true);
    };
  });
}

export function timeAgo(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (!ts) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(Number(ts)).toLocaleDateString();
}

export function bytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ markdown */
const CODE_PLACEHOLDER = '\u0000CODE';

export function md(source) {
  let text = String(source ?? '');
  const blocks = [];
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return `${CODE_PLACEHOLDER}${blocks.length - 1}\u0000`;
  });
  text = escapeHtml(text);

  // inline
  text = text
    .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const lines = text.split('\n');
  const out = [];
  let list = null;
  let inQuote = false;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join(' ')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push(line.trim());
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
      if (inQuote) {
        out.push('</blockquote>');
        inQuote = false;
      }
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      out.push(`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`);
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      out.push(`<p>${line.replace(/^>\s?/, '')}</p>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${ol[1]}</li>`);
      continue;
    }
    if (/^\|/.test(line) && line.includes('|')) {
      flushPara();
      closeList();
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      const prev = out[out.length - 1] || '';
      if (prev.startsWith('<table')) {
        out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
      } else {
        out.push(`<table><thead><tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`);
      }
      continue;
    }
    if (out[out.length - 1]?.startsWith('<table') || (out[out.length - 1] || '').startsWith('<tr>')) {
      if (!line.startsWith('|')) out.push('</tbody></table>');
    }
    para.push(line);
  }
  flushPara();
  closeList();
  if (inQuote) out.push('</blockquote>');
  let html = out.join('\n');
  html = html.replace(/<table><thead>([\s\S]*?)<\/thead><tbody>([\s\S]*?)(<\/tbody><\/table>|$)/g, (m, head, rows) => `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`);
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    const block = blocks[Number(i)];
    if (!block) return '';
    const highlighted = highlight(block.code, block.lang);
    return `<pre><button class="copy-code" data-copy="1">copy</button><code class="lang-${escapeHtml(block.lang || 'txt')}">${highlighted}</code></pre>`;
  });
  return html;
}

const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue new class extends super import export from default async await try catch finally throw typeof instanceof in of delete void yield static get set null undefined true false this',
  py: 'def class return if elif else for while import from as with try except finally raise pass break continue and or not in is None True False lambda yield global nonlocal async await print',
  sh: 'if then else fi for do done while case esac function return exit export local echo cd npm node python pip git curl',
  sql: 'select from where insert into values update set delete create table drop alter add column primary key foreign references join left right inner outer on group by order limit offset and or not null as distinct count sum avg',
};

export function highlight(code, lang = '') {
  const language = String(lang || '').toLowerCase();
  const group = /^(js|javascript|ts|typescript|jsx|tsx|mjs|cjs)$/.test(language)
    ? 'js'
    : /^(py|python)$/.test(language)
      ? 'py'
      : /^(sh|bash|zsh|shell|console)$/.test(language)
        ? 'sh'
        : /^(sql)$/.test(language)
          ? 'sql'
          : /^(json|jsonc)$/.test(language)
            ? 'json'
            : '';
  if (/^(html|xml|svg|vue|svelte)$/.test(language)) {
    return escapeHtml(code)
      .replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="tok-key">$2</span>')
      .replace(/([\w-]+)=(&quot;|')/g, '<span class="tok-type">$1</span>=$2')
      .replace(/(&quot;|')([^&]*?)(&quot;|')/g, '$1<span class="tok-str">$2</span>$3');
  }
  if (/^(css|scss|less)$/.test(language)) {
    return escapeHtml(code)
      .replace(/([.#][\w-]+|\b[a-z-]+)(?=\s*\{)/g, '<span class="tok-key">$1</span>')
      .replace(/([\w-]+)(\s*:)/g, '<span class="tok-type">$1</span>$2')
      .replace(/:\s*([^;{\n]+)/g, ': <span class="tok-str">$1</span>');
  }
  if (group === 'json') {
    return escapeHtml(code)
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
      .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="tok-str">$1</span>')
      .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="tok-num">$1</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="tok-key">$1</span>');
  }
  if (!group) return escapeHtml(code);
  const esc = escapeHtml(code);
  const kw = (KEYWORDS[group] || '').split(/\s+/).join('|');
  let out = esc
    .replace(/(&quot;[^&]*?&quot;|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span class="tok-str">$1</span>')
    .replace(new RegExp(`\\b(${kw})\\b`, 'g'), '<span class="tok-key">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>')
    .replace(/(\/\/[^\n]*|#[^\n]*)/g, '<span class="tok-com">$1</span>')
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-com">$1</span>');
  return out;
}

export function renderDiff(diff, { maxLines = 400 } = {}) {
  const lines = String(diff || '').split('\n').slice(0, maxLines);
  return `<div class="diff">${lines
    .map((line) => {
      if (line.startsWith('@@')) return `<div class="hunk">${escapeHtml(line)}</div>`;
      if (line.startsWith('+++') || line.startsWith('---')) return `<div class="meta">${escapeHtml(line)}</div>`;
      if (line.startsWith('+')) return `<div class="add">${escapeHtml(line)}</div>`;
      if (line.startsWith('-')) return `<div class="del">${escapeHtml(line)}</div>`;
      return `<div>${escapeHtml(line) || '&nbsp;'}</div>`;
    })
    .join('')}</div>`;
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('Copied', 'ok', 1500),
    () => toast('Copy failed — select manually', 'err'),
  );
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function toolIcon(name) {
  if (name === 'bash' || name === 'bash_output' || name === 'kill_shell') return 'terminal';
  if (name === 'read' || name === 'write' || name === 'edit' || name === 'multiedit') return 'edit';
  if (name === 'glob' || name === 'grep' || name === 'search') return 'search';
  if (name === 'deploy') return 'rocket';
  if (name?.startsWith('db_')) return 'database';
  if (name === 'web_fetch' || name === 'web_search') return 'globe';
  if (name === 'task') return 'brain';
  if (name === 'todo_write') return 'list';
  if (name === 'checkpoint' || name === 'rewind') return 'git';
  if (name === 'install_deps' || name === 'runtime_info') return 'package';
  return 'file';
}
