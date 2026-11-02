/** Small DOM/format helpers shared by the app (kept dependency-free). */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const icon = (name, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.dot}</svg>`;

/** An icon as a DOM node (for places that build elements instead of strings). */
export const iconEl = (name, size = 14) => {
  const wrap = document.createElement('span');
  wrap.className = 'icon';
  wrap.innerHTML = icon(name, size);
  return wrap;
};

const ICONS = {
  dot: '<circle cx="12" cy="12" r="3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logo: '<path d="M5.5 18.5 12 5.5l6.5 13"/><path d="M8.6 14.2h6.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M20.5 11.5a8 8 0 0 1-11.6 7.2L4 20l1.3-4.4A8 8 0 1 1 20.5 11.5z"/>',
  message: '<path d="M20 15.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3v-3.6A2.5 2.5 0 0 1 2.5 15V7A2.5 2.5 0 0 1 5 4.5h12.5A2.5 2.5 0 0 1 20 7z"/>',
  file: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5"/>',
  files: '<path d="M9 2.5h6.5L20 7v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2z"/><path d="M15.5 2.5V7H20"/><path d="M5 7v11.5A2.5 2.5 0 0 0 7.5 21H16"/>',
  terminal: '<path d="m4.5 17 5.5-5-5.5-5"/><path d="M12 19h7.5"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13"/><path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3"/>',
  rocket: '<path d="M13.5 3.5c3.5-1.2 7.2 2.5 6 6-1.1 3.2-4.4 6.5-4.4 6.5l-4.1-4.1s3.3-3.3 6.5-4.4"/><path d="M11 11.9 6.7 9.6 4 12.3l4 1.3M12.1 13l2.3 4.3-2.7 2.7-1.3-4"/>',
  download: '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
  upload: '<path d="M12 20.5v-11"/><path d="m7.5 13.5 4.5-4.5 4.5 4.5"/><path d="M4.5 4.5h15"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.6a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.6a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.6a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V11a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.6a1.7 1.7 0 0 0-1.5 1z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  send: '<path d="M4 12 20 4l-4 16-4-6-8-2z"/>',
  'arrow-up': '<path d="M12 19.5V5"/><path d="m6 11 6-6 6 6"/>',
  'arrow-right': '<path d="M4.5 12h15"/><path d="m13.5 6 6 6-6 6"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.4"/>',
  square: '<rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" stroke="none"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5V9H15"/>',
  play: '<path d="M7 4.5 19 12 7 19.5z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  list: '<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  github: '<path d="M9 19c-4 1.5-4-2-6-2m12 5v-4c0-1 .1-1.5-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.4-.4-4.6 1.7a11 11 0 0 0-6 0C4.8 3.2 3.4 3.6 3.4 3.6a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 2 10c0 4.6 2.7 5.7 5.5 6-.6.5-.6 1.2-.5 2v4"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6 1.5A3.75 3.75 0 0 0 7 19z"/>',
  triangle: '<path d="M12 4 3 20h18z"/>',
  diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
  spark: '<path d="M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9L5.2 10.3l4.9-1.9z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M10 10h4v4h-4z"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
  check: '<path d="m4.5 12.5 4.5 4.5L19.5 6.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
  warn: '<path d="M12 4.2 2.8 19.5h18.4z"/><path d="M12 9.5v4.2M12 17h.01"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>',
  trash: '<path d="M4 7h16M9.5 7V4.8h5V7"/><path d="M6 7l1 12.2h10L18 7"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.7l2 2h7.3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  'folder-open': '<path d="M3.5 8V6.5a2 2 0 0 1 2-2h3.7l2 2h6.3a2 2 0 0 1 2 2V10"/><path d="M3.5 8h16.2a1.3 1.3 0 0 1 1.28 1.55l-1.6 7.5a2 2 0 0 1-1.96 1.45H4.6a1.1 1.1 0 0 1-1.1-1.1z"/>',
  wand: '<path d="m4 20 8.5-8.5"/><path d="M14.5 3.6l1.4 2.8 2.9 1.4-2.9 1.4-1.4 2.9-1.4-2.9-2.9-1.4 2.9-1.4z"/><path d="M19.2 15l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"/>',
  pencil: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 6.5 3 3"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/><path d="M12 8v4.3l3 1.8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.4v4.9l3.1 1.9"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  paperclip: '<path d="M20.5 12.5 12.3 20.7a5 5 0 0 1-7-7l8.2-8.2a3.4 3.4 0 0 1 4.8 4.8l-8.2 8.2a1.9 1.9 0 0 1-2.7-2.7l7.5-7.5"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  tablet: '<rect x="5" y="2.5" width="14" height="19" rx="3"/><path d="M11 18.4h2"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="3"/><path d="M11 18.4h2"/>',
  cursor: '<path d="m4.5 3.5 6.8 16.4 2.4-6.2 6.2-2.4z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5"/>',
  bolt: '<path d="M13.5 2.5 4.5 14h6l-1 7.5 9-11.5h-6z"/>',
  camera: '<path d="M4 8.5h2.8l1.7-2.6h7l1.7 2.6H20a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5z"/><circle cx="12" cy="13.5" r="3.3"/>',
  link: '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3"/>',
  shield: '<path d="M12 3 5 5.8v5.6c0 4 2.9 7.2 7 9.6 4.1-2.4 7-5.6 7-9.6V5.8z"/><path d="m9 12 2.2 2.2 4-4"/>',
  code: '<path d="m9 18-5.5-6L9 6"/><path d="m15 6 5.5 6L15 18"/>',
  'code-square': '<rect x="3" y="3.5" width="18" height="17" rx="3"/><path d="m10 9-3 3 3 3M14 9l3 3-3 3"/>',
  moon: '<path d="M20.5 14.7A8.6 8.6 0 0 1 9.3 3.5a8.6 8.6 0 1 0 11.2 11.2z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.8M12 18.7v2.8M2.5 12h2.8M18.7 12h2.8M5.2 5.2l2 2M16.8 16.8l2 2M18.8 5.2l-2 2M7.2 16.8l-2 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20.5 20.5-5-5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4M12 16.6h.01"/>',
  'panel-right': '<rect x="3" y="3.5" width="18" height="17" rx="3"/><path d="M15 3.5v17"/>',
  'panel-left': '<rect x="3" y="3.5" width="18" height="17" rx="3"/><path d="M9 3.5v17"/>',
  maximize: '<path d="M8.5 3.5h-5v5M15.5 3.5h5v5M20.5 15.5v5h-5M3.5 15.5v5h5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.9 0-1.5-1.3-1.7-1.3-2.9 0-1 .8-1.7 1.9-1.7h1.6A4.3 4.3 0 0 0 20.5 10a8.5 8.5 0 0 0-8.5-6.5z"/><circle cx="8" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="10" r="1.1" fill="currentColor" stroke="none"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  package: '<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="m3.5 7.5 8.5 4.6 8.5-4.6M12 12.1V21"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.4 3.6 5.4 3.6 8.5S14.4 18.1 12 20.5C9.6 18.1 8.4 15.1 8.4 12S9.6 5.9 12 3.5z"/>',
  key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12h9M17.5 12v3M20 12v2.2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  loader: '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18"/>',
  'arrow-down': '<path d="M12 4.5V19"/><path d="m6 13 6 6 6-6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  bug: '<path d="M8 6.5a4 4 0 0 1 8 0"/><rect x="6.5" y="8" width="11" height="11" rx="4"/><path d="M6.5 12H3M21 12h-3.5M6.5 16H4M20 16h-2.5M9 4.5 7.5 2.5M15 4.5 16.5 2.5"/>',
  zap: '<path d="M13.5 2.5 4.5 14h6l-1 7.5 9-11.5h-6z"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.5 6H14a4 4 0 0 1 4 4v.5"/>',
  type: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  layout: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M3.5 9.5h17M9.5 9.5v11"/>',
};

export function paintIcons(root = document) {
  for (const node of $$('[data-icon]', root)) {
    if (node.dataset.iconDone === '1') continue;
    node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, Number(node.dataset.iconSize) || 14));
    node.dataset.iconDone = '1';
  }
}

export const timeAgo = (ts) => {
  if (!ts) return '';
  const s = Math.max(1, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const bytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/** Tiny safe markdown renderer: headings, lists, code, bold, links, escapes HTML. */
export function md(src) {
  const blocks = String(src ?? '').split(/```/);
  let out = '';
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      const [lang, ...rest] = block.split('\n');
      out += `<pre class="code"><code data-lang="${escapeHtml(lang.trim())}">${escapeHtml(rest.join('\n').replace(/\n$/, ''))}</code></pre>`;
      return;
    }
    out += inline(block);
  });
  return out;
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>').replace(/^##\s+(.+)$/gm, '<h3>$1</h3>').replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/^(\s*)[-*]\s+(.+)$/gm, '$1<li>$2</li>');
  out = out.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  out = out.replace(/^(\d+)\.\s+(.+)$/gm, '<div class="oli"><b>$1.</b> $2</div>');
  return out
    .split(/\n{2,}/)
    .map((para) => (/^\s*<(h\d|ul|pre|div)/.test(para) ? para : `<p>${para.replace(/\n/g, '<br>')}</p>`))
    .join('');
}

export function renderDiff(diff) {
  if (!diff) return '';
  return `<pre class="diff">${String(diff)
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join('\n')}</pre>`;
}

let toastHost = null;
export function toast(message, kind = '', ms = 3200) {
  toastHost = toastHost || $('#toasts');
  if (!toastHost) return;
  const node = el('div', { class: `toast ${kind}`, text: String(message) });
  toastHost.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied', 'ok', 1400);
  } catch {
    toast('Copy failed — select it manually', 'err');
  }
}

export function debounce(fn, ms = 220) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------- dialogs ---- */

/**
 * An in-app replacement for `window.prompt` / `window.confirm`, which are
 * blocked inside sandboxed frames and look nothing like the rest of the app.
 *
 * Resolves to the trimmed string, or null when dismissed.
 */
export function askText({ title = 'Rename', label = '', value = '', placeholder = '', confirm = 'Save', mono = true } = {}) {
  return new Promise((resolve) => {
    const host = $('#dialog-sheet');
    if (!host) return resolve(null);
    host.innerHTML = `
      <div class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">${escapeHtml(title)}</h2>
        ${label ? `<label class="dialog-label" for="dialog-input">${escapeHtml(label)}</label>` : ''}
        <input id="dialog-input" class="${mono ? 'mono' : ''}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false">
        <div class="dialog-actions">
          <button class="btn" data-dialog-cancel>Cancel</button>
          <button class="btn primary" data-dialog-ok>${escapeHtml(confirm)}</button>
        </div>
      </div>`;
    host.hidden = false;
    const input = $('#dialog-input', host);
    setTimeout(() => {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }, 10);
    const done = (result) => {
      host.hidden = true;
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      host.onclick = null;
      resolve(result);
    };
    const submit = () => done(input.value.trim() || null);
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        done(null);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    host.onclick = (event) => {
      if (event.target === host) done(null);
    };
    $('[data-dialog-cancel]', host).onclick = () => done(null);
    $('[data-dialog-ok]', host).onclick = submit;
  });
}

export function askConfirm({ title = 'Are you sure?', body = '', confirm = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const host = $('#dialog-sheet');
    if (!host) return resolve(false);
    host.innerHTML = `
      <div class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">${escapeHtml(title)}</h2>
        ${body ? `<p class="dialog-body">${escapeHtml(body)}</p>` : ''}
        <div class="dialog-actions">
          <button class="btn" data-dialog-cancel>Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-dialog-ok>${escapeHtml(confirm)}</button>
        </div>
      </div>`;
    host.hidden = false;
    const ok = $('[data-dialog-ok]', host);
    setTimeout(() => ok.focus(), 10);
    const done = (result) => {
      host.hidden = true;
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      host.onclick = null;
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        done(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        done(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    host.onclick = (event) => {
      if (event.target === host) done(false);
    };
    $('[data-dialog-cancel]', host).onclick = () => done(false);
    ok.onclick = () => done(true);
  });
}
