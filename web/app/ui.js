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

export const icon = (name, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.dot}</svg>`;

const ICONS = {
  dot: '<circle cx="12" cy="12" r="3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logo: '<path d="M5 19 12 4l7 15"/><path d="M8.5 14h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M21 12a8 8 0 1 1-3.1-6.3L21 4l-1 4.2A8 8 0 0 1 21 12z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  rocket: '<path d="M5 15c-1 2-1 5-1 5s3 0 5-1"/><path d="M9 14 4 9l4-1 3-3c3-3 7-2 8-1s2 5-1 8l-3 3-1 4-5-5z"/>',
  download: '<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M4 21h16"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>',
  send: '<path d="M4 12 20 4l-4 16-4-6-8-2z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  github: '<path d="M9 19c-4 1.5-4-2-6-2m12 5v-4c0-1 .1-1.5-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.4-.4-4.6 1.7a11 11 0 0 0-6 0C4.8 3.2 3.4 3.6 3.4 3.6a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 2 10c0 4.6 2.7 5.7 5.5 6-.6.5-.6 1.2-.5 2v4"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6 1.5A3.75 3.75 0 0 0 7 19z"/>',
  triangle: '<path d="M12 4 3 20h18z"/>',
  diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
  spark: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 9h6v6H9z"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  warn: '<path d="M12 4 2 20h20z"/><path d="M12 10v5m0 3h.01"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};

export function paintIcons(root = document) {
  for (const node of $$('[data-icon]', root)) {
    if (node.dataset.iconDone === '1') continue;
    node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon, node.dataset.iconSize || 14));
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
