/**
 * The code workspace: a file tree you can actually operate, and an editor with
 * tabs, line numbers, autosave and a real undo history.
 *
 * Everything here talks to the app through `deps` so the agent loop in main.js
 * stays readable. The point of the module is that a person can *work* in it:
 * create, rename, delete, upload, download, import a ZIP, edit without losing
 * changes, and see what the agent changed underneath them.
 */
import { $, el, icon, fileIcon, escapeHtml, bytes, toast, timeAgo } from './ui.js';
import { isBinaryPath } from '../engine/fs.js';
import { zipSync, download } from '../engine/zip.js';
import { unzipSync } from 'fflate';
import {
  supportsFolderMount,
  pickFolder,
  FolderMount,
  saveMountHandle,
  loadMountHandle,
  clearMountHandle,
  filesFromDrop,
  MOUNT_LIMITS,
} from '../engine/mount.js';

const deps = {};
const state = {
  files: [],
  open: [], // [{ path, text, saved, dirty, scroll, cursor }]
  active: null,
  filter: '',
  lastClick: null,
  modulesOpen: false, // node_modules folded in the tree
  depsOpen: false, // dependency card expanded
  mount: null, // FolderMount
  mountInfo: null,
  mountSyncing: null,
};

const TEXT_LIMIT = 1_500_000;

export function mountFiles(injected) {
  Object.assign(deps, injected);
  bindToolbar();
  bindDragDrop();
  bindShortcuts();
  renderTabs();
  renderEditor();
  $('#editor-back')?.addEventListener('click', () => setMobileEditor(false));
}

/** On a phone, opening a file replaces the list; this is the way back. */
function setMobileEditor(open) {
  $('#view-files')?.classList.toggle('mobile-editor', Boolean(open));
}

/* ------------------------------------------------------------------ tree -- */

export async function refreshFileTree({ keepOpen = true } = {}) {
  // Boot opens the last project before this module is mounted; there is simply
  // nothing to draw yet, and the first mount refreshes.
  const app = deps.getState?.();
  if (!app?.project || !app.fs) return;
  state.files = await app.fs.list(app.project.id);
  if (!keepOpen) state.open = [];
  renderTree();
  renderTabs();
  renderMountBar();
  renderDependencies();
  syncOpenWithDisk();
}

/* ----------------------------------------------------------- file tree ---- */

function renderTree() {
  const host = $('#file-tree');
  if (!host) return;
  const query = state.filter.trim().toLowerCase();
  const matches = (path) => !query || path.toLowerCase().includes(query);

  // node_modules is thousands of files nobody wants to scroll; it gets one
  // row with a package count, and a click opens the package list.
  const modules = state.files.filter((f) => f.path.startsWith('node_modules/') && matches(f.path));
  const files = state.files.filter((f) => !f.path.startsWith('node_modules/') && matches(f.path));
  host.innerHTML = '';

  if (!state.files.length) {
    host.innerHTML = `<div class="tree-empty">
      <span class="tree-empty-icon">${icon('files', 20)}</span>
      <p>No files yet.</p>
      <p class="hint">Ask the agent to build something, drop files here, or create one.</p>
      <div class="tree-empty-actions">
        <button class="btn sm" data-empty-new>${icon('plus', 13)} New file</button>
        <button class="btn sm" data-empty-upload>${icon('upload', 13)} Upload</button>
        <button class="btn sm" data-empty-mount>${icon('folder-plus', 13)} Mount a folder</button>
      </div>
    </div>`;
    host.querySelector('[data-empty-new]').onclick = () => newFile();
    host.querySelector('[data-empty-upload]').onclick = () => pickFiles();
    host.querySelector('[data-empty-mount]').onclick = () => mountFolder();
    return;
  }

  if (!files.length && !modules.length) {
    host.innerHTML = `<div class="tree-empty"><p>Nothing matches “${escapeHtml(state.filter)}”.</p></div>`;
    return;
  }

  // Folders first, then files, with shared prefixes collapsed into groups.
  const groups = new Map();
  for (const file of files) {
    const parts = file.path.split('/');
    const group = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(file);
  }
  const sortedGroups = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));

  for (const group of sortedGroups) {
    if (group) {
      const head = el('div', { class: 'tree-group', html: `${icon('folder-open', 12)}<span>${escapeHtml(group)}</span><span class="tree-count">${groups.get(group).length}</span>` });
      host.append(head);
    }
    for (const file of groups.get(group).sort((a, b) => a.path.localeCompare(b.path))) {
      host.append(treeNode(file, group ? 1 : 0));
    }
  }

  if (modules.length) host.append(modulesRow(modules));
  if (!files.length && query) {
    host.insertAdjacentHTML('afterbegin', `<div class="tree-empty small"><p>No project file matches “${escapeHtml(state.filter)}”.</p></div>`);
  }
}

/** The folded `node_modules` row and the package list behind it. */
function modulesRow(modules) {
  const packages = new Map();
  for (const file of modules) {
    const parts = file.path.split('/');
    const name = parts[1]?.startsWith('@') ? `${parts[1]}/${parts[2] || ''}` : parts[1];
    if (!name) continue;
    packages.set(name, (packages.get(name) || 0) + 1);
  }
  const wrap = el('div', { class: 'tree-modules' });
  const row = el('div', { class: 'tree-row module-head', role: 'button', tabindex: '0' });
  row.innerHTML = `${icon(state.modulesOpen ? 'chevron-down' : 'chevron-right', 12)}
    <span class="ft ft-modules">${icon('boxes', 13)}</span>
    <span class="path">node_modules</span>
    <span class="tree-count">${packages.size} package${packages.size === 1 ? '' : 's'}</span>`;
  row.onclick = () => {
    state.modulesOpen = !state.modulesOpen;
    renderTree();
  };
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    }
  };
  wrap.append(row);

  if (state.modulesOpen) {
    for (const [name, count] of [...packages].sort((a, b) => a[0].localeCompare(b[0]))) {
      const item = el('div', { class: 'tree-row module-row' });
      item.innerHTML = `${icon('package', 12)}<span class="path">${escapeHtml(name)}</span><span class="size">${count}</span>`;
      item.title = `${name} — ${count} file${count === 1 ? '' : 's'}`;
      item.onclick = () => openFile(`node_modules/${name}/package.json`);
      wrap.append(item);
    }
  }
  return wrap;
}
function treeNode(file, depth) {
  const name = file.path.split('/').pop();
  const row = el('div', {
    class: `tree-row ${file.path === state.active ? 'active' : ''} ${file.path === state.lastClick ? 'flash' : ''}`,
  });
  row.style.paddingLeft = `${8 + depth * 10}px`;
  row.innerHTML = `${fileIcon(file.path, 13)}<span class="path">${escapeHtml(name)}</span><span class="size">${bytes(file.size || 0)}</span>
    <button class="tree-more" title="File actions" aria-label="Actions for ${escapeHtml(name)}">${icon('more', 13)}</button>`;
  row.onclick = (event) => {
    if (event.target.closest('.tree-more')) return;
    openFile(file.path);
  };
  row.oncontextmenu = (event) => {
    event.preventDefault();
    openFileMenu(file, event.clientX, event.clientY);
  };
  row.querySelector('.tree-more').onclick = (event) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openFileMenu(file, rect.left, rect.bottom + 4);
  };
  return row;
}

/** A small anchored menu (no native `prompt`, which is blocked in embeds). */
function openFileMenu(file, x, y) {
  document.querySelector('.ctx-menu')?.remove();
  const menu = el('div', { class: 'ctx-menu' });
  const action = (label, glyph, run, danger = false) => {
    const item = el('button', { class: `ctx-item ${danger ? 'danger' : ''}` });
    item.innerHTML = `${icon(glyph, 14)}<span>${label}</span>`;
    item.onclick = () => {
      menu.remove();
      run();
    };
    menu.append(item);
  };
  action('Open', 'file', () => openFile(file.path));
  action('Rename', 'pencil', () => renameFile(file.path));
  action('Duplicate', 'files', () => duplicateFile(file.path));
  action('Download', 'download', () => downloadFile(file.path));
  action('Delete', 'trash', () => deleteFile(file.path), true);
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  const close = (event) => {
    if (menu.contains(event.target)) return;
    menu.remove();
    document.removeEventListener('pointerdown', close);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close(event);
  };
  setTimeout(() => document.addEventListener('pointerdown', close), 0);
  document.addEventListener('keydown', onKey, true);
}

/* ----------------------------------------------------------------- files -- */

export async function openFile(path, { line = null } = {}) {
  const app = deps.getState();
  if (!app.project) return;
  if (isBinaryPath(path)) return downloadFile(path);

  let entry = state.open.find((f) => f.path === path);
  if (!entry) {
    let text = '';
    try {
      text = await app.fs.readText(app.project.id, path);
    } catch (err) {
      toast(`Could not open ${path}: ${err.message}`, 'err');
      return;
    }
    if (text.length > TEXT_LIMIT) {
      toast(`${path} is ${bytes(text.length)} — opening read-only`, 'warn');
    }
    entry = { path, text, saved: text, scroll: 0, cursor: 0, readOnly: text.length > TEXT_LIMIT };
    state.open.push(entry);
  }
  state.active = path;
  state.lastClick = path;
  renderTabs();
  renderTree();
  renderEditor({ line });
  setMobileEditor(true);
  if (deps.setView) deps.setView('files');
}

function renderEditor({ line = null } = {}) {
  const entry = state.open.find((f) => f.path === state.active);
  const host = $('#editor-host');
  if (!host) return;
  if (!entry) {
    host.innerHTML = `<div class="editor-empty">
      ${icon('code-square', 26)}
      <p>Nothing open yet</p>
      <span>Pick a file on the left, or <button class="link" id="editor-empty-new">create one</button>.</span>
    </div>`;
    host.querySelector('#editor-empty-new')?.addEventListener('click', () => newFile());
    return;
  }

  const ext = (entry.path.split('.').pop() || '').toLowerCase();
  const lines = entry.text.split('\n');
  host.innerHTML = `
    <div class="editor-panes">
      <pre class="gutter" id="gutter" aria-hidden="true">${lines.map((_, i) => i + 1).join('\n')}</pre>
      <textarea id="editor" class="editor" spellcheck="false" autocomplete="off" autocapitalize="off"
        aria-label="Editing ${escapeHtml(entry.path)}" ${entry.readOnly ? 'readonly' : ''}>${escapeHtml(entry.text)}</textarea>
    </div>
    <div class="editor-status">
      <span class="mono" id="editor-lang">${escapeHtml(ext || 'text')}</span>
      <span id="editor-lines">${lines.length} lines</span>
      <span class="grow"></span>
      <span id="editor-save-state" class="save-state">${entry.readOnly ? 'read-only' : entry.dirty ? 'unsaved' : 'saved'}</span>
    </div>`;

  const textarea = host.querySelector('#editor');
  const gutter = host.querySelector('#gutter');
  textarea.value = entry.text;
  textarea.scrollTop = entry.scroll || 0;
  textarea.setSelectionRange(entry.cursor || 0, entry.cursor || 0);
  const sync = () => {
    gutter.scrollTop = textarea.scrollTop;
    gutter.style.transform = `translateY(${-textarea.scrollTop}px)`;
  };
  gutter.style.transform = `translateY(${-(entry.scroll || 0)}px)`;
  textarea.onscroll = sync;

  textarea.oninput = () => {
    entry.text = textarea.value;
    entry.scroll = textarea.scrollTop;
    entry.cursor = textarea.selectionStart;
    const count = entry.text.split('\n').length;
    const lineNode = host.querySelector('#editor-lines');
    if (lineNode) lineNode.textContent = `${count} lines`;
    if (count !== gutter.childElementCount) {
      gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
    }
    markDirty(entry);
    scheduleSave(entry);
    sync();
  };
  textarea.onkeydown = (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      insertAtCursor(textarea, '  ');
      textarea.dispatchEvent(new Event('input'));
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveEntry(entry, { force: true });
    }
  };
  textarea.onblur = () => {
    entry.cursor = textarea.selectionStart;
    entry.scroll = textarea.scrollTop;
    saveEntry(entry);
  };

  // Put the caret in the file you just opened: the most common next action is typing.
  if (!line && !entry.readOnly) {
    textarea.focus({ preventScroll: true });
    const caret = Math.min(entry.cursor || 0, entry.text.length);
    textarea.setSelectionRange(caret, caret);
  }
  if (line) {
    const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, l) => sum + l.length + 1, 0);
    textarea.focus();
    textarea.setSelectionRange(offset, offset + (lines[line - 1] || '').length);
    textarea.scrollTop = Math.max(0, (line - 4) * 18);
    sync();
  }
  const status = host.querySelector('#editor-save-state');
  if (status) status.className = `save-state ${entry.readOnly ? 'warn' : entry.dirty ? 'dirty' : 'ok'}`;
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
}

const timers = new Map();

function scheduleSave(entry) {
  clearTimeout(timers.get(entry.path));
  timers.set(
    entry.path,
    setTimeout(() => saveEntry(entry), 600),
  );
}

async function saveEntry(entry, { force = false } = {}) {
  if (!entry || entry.readOnly) return;
  if (!entry.dirty && !force) return;
  const app = deps.getState();
  if (!app.project) return;
  clearTimeout(timers.get(entry.path));
  try {
    await app.fs.write(app.project.id, entry.path, entry.text);
    entry.saved = entry.text;
    entry.dirty = false;
    const info = state.files.find((f) => f.path === entry.path);
    if (info) info.size = entry.text.length;
    markClean(entry);
    deps.onFilesChanged?.({ source: 'editor', path: entry.path });
  } catch (err) {
    toast(`Could not save ${entry.path}: ${err.message}`, 'err');
  }
}

export async function saveActiveFile() {
  const entry = state.open.find((f) => f.path === state.active);
  await saveEntry(entry, { force: true });
}

function markDirty(entry) {
  entry.dirty = true;
  const tab = document.querySelector(`.file-tab[data-path="${cssEscape(entry.path)}"]`);
  tab?.classList.add('dirty');
  const status = $('#editor-save-state');
  if (status) {
    status.textContent = 'saving…';
    status.className = 'save-state dirty';
  }
}

function markClean(entry) {
  const tab = document.querySelector(`.file-tab[data-path="${cssEscape(entry.path)}"]`);
  tab?.classList.remove('dirty');
  const status = $('#editor-save-state');
  if (status) {
    status.textContent = 'saved';
    status.className = 'save-state ok';
  }
}

const cssEscape = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));

/* ------------------------------------------------------------------ tabs -- */

function renderTabs() {
  const host = $('#editor-tabs');
  if (!host) return;
  host.innerHTML = '';
  for (const entry of state.open) {
    const tab = el('div', { class: `file-tab ${entry.path === state.active ? 'active' : ''} ${entry.dirty ? 'dirty' : ''}` });
    tab.dataset.path = entry.path;
    const name = entry.path.split('/').pop();
    tab.innerHTML = `${icon(isBinaryPath(entry.path) ? 'package' : 'file', 12)}<span class="tab-name">${escapeHtml(name)}</span>
      <button class="tab-close" aria-label="Close ${escapeHtml(name)}">${icon('close', 11)}</button>`;
    tab.title = entry.path;
    tab.onclick = (event) => {
      if (event.target.closest('.tab-close')) return;
      state.active = entry.path;
      renderTabs();
      renderTree();
      renderEditor();
    };
    tab.querySelector('.tab-close').onclick = (event) => {
      event.stopPropagation();
      closeFile(entry.path);
    };
    host.append(tab);
  }
  // Keep the active tab in view without scrolling the whole page.
  const active = host.querySelector('.file-tab.active');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function closeFile(path) {
  const index = state.open.findIndex((f) => f.path === path);
  if (index === -1) return;
  const entry = state.open[index];
  if (entry.dirty) await saveEntry(entry, { force: true });
  state.open.splice(index, 1);
  if (state.active === path) state.active = state.open[Math.max(0, index - 1)]?.path || null;
  renderTabs();
  renderTree();
  renderEditor();
  if (!state.open.length) setMobileEditor(false);
}

/* --------------------------------------------------------------- actions -- */

export async function newFile(dir = '') {
  const name = await deps.ask({
    title: 'New file',
    label: 'Path, relative to the project',
    value: dir ? `${dir}/` : 'src/',
    placeholder: 'styles/theme.css',
    confirm: 'Create',
  });
  if (!name) return;
  const app = deps.getState();
  const path = name.trim().replace(/^\/+/, '');
  if (!path) return;
  if (await app.fs.exists(app.project.id, path)) {
    toast(`${path} already exists`, 'warn');
    return openFile(path);
  }
  await app.fs.write(app.project.id, path, '');
  await refreshFileTree();
  await openFile(path);
  deps.onFilesChanged?.({ source: 'editor', path });
}

async function renameFile(path) {
  const name = await deps.ask({
    title: 'Rename file',
    label: 'New path',
    value: path,
    confirm: 'Rename',
  });
  if (!name || name === path) return;
  const app = deps.getState();
  const next = name.trim().replace(/^\/+/, '');
  await app.fs.move(app.project.id, path, next);
  const entry = state.open.find((f) => f.path === path);
  if (entry) entry.path = next;
  if (state.active === path) state.active = next;
  await refreshFileTree();
  renderTabs();
  renderEditor();
  deps.onFilesChanged?.({ source: 'editor', path: next });
}

async function duplicateFile(path) {
  const app = deps.getState();
  const dot = path.lastIndexOf('.');
  const next = dot > 0 ? `${path.slice(0, dot)} copy${path.slice(dot)}` : `${path} copy`;
  const text = await app.fs.readText(app.project.id, path).catch(() => '');
  await app.fs.write(app.project.id, next, text);
  await refreshFileTree();
  toast(`Duplicated to ${next}`, 'ok');
}

async function deleteFile(path) {
  const ok = await deps.confirm({
    title: `Delete ${path}?`,
    body: 'This removes the file from this project. Version history still has a copy.',
    confirm: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const app = deps.getState();
  await app.fs.remove(app.project.id, path);
  const index = state.open.findIndex((f) => f.path === path);
  if (index !== -1) state.open.splice(index, 1);
  if (state.active === path) state.active = state.open[0]?.path || null;
  await refreshFileTree();
  renderTabs();
  renderEditor();
  if (!state.open.length) setMobileEditor(false);
  deps.onFilesChanged?.({ source: 'editor', path });
}

export async function downloadFile(path) {
  const app = deps.getState();
  const raw = await app.fs.read(app.project.id, path).catch(() => null);
  if (!raw) return toast(`${path} is empty`, 'warn');
  download(path.split('/').pop(), raw instanceof Uint8Array ? raw : new TextEncoder().encode(String(raw)));
}

export async function downloadProjectZip() {
  const app = deps.getState();
  const files = {};
  for (const file of await app.fs.list(app.project.id)) {
    if (file.path.startsWith('node_modules/')) continue;
    const raw = await app.fs.read(app.project.id, file.path).catch(() => null);
    if (raw == null) continue;
    files[file.path] = raw;
  }
  const name = (app.project.name || 'project').replace(/[^\w.-]+/g, '-').toLowerCase();
  const size = download(`${name}.zip`, zipSync(files));
  toast(`Exported ${Object.keys(files).length} files (${bytes(size)})`, 'ok');
}

/* ---------------------------------------------------------------- upload -- */

export function pickFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => uploadFiles([...input.files]);
  input.click();
}

/** Write dropped/selected files into the project, preserving folder structure. */
export async function uploadFiles(fileList, { dir = '' } = {}) {
  const app = deps.getState();
  if (!app.project) return;
  let written = 0;
  let skipped = 0;
  for (const file of fileList) {
    const rawPath = (file.webkitRelativePath || file.name || '').replace(/^\/+/, '');
    if (!rawPath) continue;
    const path = dir ? `${dir.replace(/\/$/, '')}/${rawPath}` : rawPath;
    try {
      if (file.size > 4_000_000) {
        skipped += 1;
        continue;
      }
      if (isBinaryPath(path) || (file.type && !/^text|json|javascript|xml|svg|csv|sql/.test(file.type))) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        await app.fs.write(app.project.id, path, buffer);
      } else {
        await app.fs.write(app.project.id, path, await file.text());
      }
      written += 1;
    } catch (err) {
      skipped += 1;
      console.warn('upload failed', path, err);
    }
  }
  await refreshFileTree();
  if (written) deps.onFilesChanged?.({ source: 'upload' });
  if (written) toast(`${written} file${written === 1 ? '' : 's'} added${skipped ? `, ${skipped} skipped` : ''}`, 'ok');
  else if (skipped) toast('Nothing was added — files were too large or unreadable', 'warn');
  if (written) {
    const first = fileList[0];
    if (first && !isBinaryPath(first.name)) openFile(dir ? `${dir}/${first.webkitRelativePath || first.name}` : first.webkitRelativePath || first.name);
  }
}

/** Import a .zip by unpacking it into the project. */
export async function importZipFile(file) {
  const app = deps.getState();
  const data = new Uint8Array(await file.arrayBuffer());
  let unzipped;
  try {
    unzipped = unzipSync(data);
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`, 'err');
    return;
  }
  const entries = Object.entries(unzipped).filter(([path]) => !path.endsWith('/') && !path.includes('__MACOSX'));
  const prefix = commonPrefix(entries.map(([path]) => path));
  let written = 0;
  for (const [path, content] of entries) {
    const rel = path.slice(prefix.length);
    if (!rel) continue;
    await app.fs.write(app.project.id, rel, content);
    written += 1;
  }
  await refreshFileTree();
  deps.onFilesChanged?.({ source: 'import' });
  toast(`Imported ${written} files from ${file.name}`, 'ok');
}

const commonPrefix = (paths) => {
  if (!paths.length) return '';
  const first = paths[0];
  const cut = first.lastIndexOf('/');
  if (cut === -1) return '';
  const prefix = first.slice(0, cut + 1);
  return paths.every((p) => p.startsWith(prefix)) ? prefix : '';
};

/* ----------------------------------------------------------- repo import -- */

const REPO_SKIP = /(^|\/)(node_modules|dist|build|\.git|\.next|coverage|vendor)(\/|$)|(^|\/)\.DS_Store$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/;
const REPO_MAX_FILES = 400;
const REPO_MAX_BYTES = 1_500_000;

/**
 * Pull a GitHub repository into this project.
 *
 * Public repos need no account. When GitHub is connected the token is used, so
 * private repos work too, and the import is a real copy of the files — not a
 * link that breaks the moment the tab closes.
 */
export async function importRepo() {
  const value = await deps.ask({
    title: 'Import a repository',
    label: 'owner/repo — public, or any repo you can read',
    value: '',
    placeholder: 'vercel/next.js',
    confirm: 'Import',
  });
  if (!value) return;
  const match = String(value)
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+))?\/?$/);
  if (!match) {
    toast('Use the form owner/repo, for example vercel/next.js', 'warn', 5000);
    return;
  }
  const [, owner, repo, maybeBranch] = match;
  const branch = maybeBranch || 'main';
  const app = deps.getState();
  const token = app.settings?.github?.token;
  const headers = token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : { Accept: 'application/vnd.github+json' };

  const progress = showImportProgress(`${owner}/${repo}`);
  try {
    let tree = await fetchTree(owner, repo, branch, headers);
    if (!tree) {
      // Most repositories are still `master`, and some use something else again.
      const meta = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }).then((r) => (r.ok ? r.json() : null));
      const fallback = meta?.default_branch;
      if (fallback && fallback !== branch) tree = await fetchTree(owner, repo, fallback, headers);
      if (!tree && meta) throw new Error(`Could not read the ${branch} branch of ${owner}/${repo}`);
      if (!tree) throw new Error(`Repository ${owner}/${repo} was not found (or is private — connect GitHub first)`);
      return finishImport(tree, owner, repo, fallback, headers, progress);
    }
    return await finishImport(tree, owner, repo, branch, headers, progress);
  } catch (err) {
    progress.fail(err.message);
    toast(err.message, 'err', 6000);
  }
}

async function fetchTree(owner, repo, branch, headers) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data.tree) ? data.tree : null;
}

async function finishImport(tree, owner, repo, branch, headers, progress) {
  const app = deps.getState();
  const blobs = tree
    .filter((node) => node.type === 'blob' && !REPO_SKIP.test(node.path) && (node.size || 0) <= REPO_MAX_BYTES)
    .slice(0, REPO_MAX_FILES);
  if (!blobs.length) throw new Error('That repository has no importable files');

  // A repo usually wraps the app in one folder; drop it so `index.html` is where
  // the preview expects it.
  const depthOne = new Set(blobs.map((b) => b.path.split('/')[0]));
  const topLevelFiles = blobs.filter((b) => !b.path.includes('/')).length;
  const strip = depthOne.size === 1 && topLevelFiles === 0 && blobs[0].path.includes('/');

  let written = 0;
  for (const [index, blob] of blobs.entries()) {
    const path = strip ? blob.path.split('/').slice(1).join('/') : blob.path;
    if (!path) continue;
    progress.set(index + 1, blobs.length, path);
    try {
      // The blob API is one host (CORS-enabled), respects the token and needs no
      // path encoding — raw.githubusercontent differs in all three.
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${blob.sha}`, { headers });
      if (!res.ok) continue;
      const payload = await res.json();
      const bytes = base64ToBytes(payload.content || '');
      await app.fs.write(app.project.id, path, isBinaryPath(path) ? bytes : new TextDecoder().decode(bytes));
      written += 1;
    } catch (err) {
      console.warn('import skip', blob.path, err);
    }
  }
  progress.done(written);
  await refreshFileTree();
  deps.onFilesChanged?.({ source: 'repo' });
  toast(`Imported ${written} file${written === 1 ? '' : 's'} from ${owner}/${repo}`, 'ok', 4200);
  const entry = written ? ['index.html', 'src/App.jsx', 'README.md'].find((p) => !isBinaryPath(p)) : null;
  if (entry) {
    const exists = await app.fs.exists(app.project.id, entry);
    if (exists) openFile(entry);
  }
}

function base64ToBytes(base64) {
  const clean = String(base64).replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function showImportProgress(label) {
  const host = document.querySelector('#toasts');
  const node = el('div', { class: 'toast import-progress' });
  node.innerHTML = `<span class="import-spinner"></span><span class="import-text">Cloning ${escapeHtml(label)}…</span>`;
  host?.append(node);
  const text = () => node.querySelector('.import-text');
  return {
    set(done, total, path) {
      const t = text();
      if (t) t.textContent = `${done} / ${total} · ${path}`;
    },
    done(count) {
      node.remove();
      if (!count) toast('Nothing could be imported from that repository', 'warn');
    },
    fail(message) {
      node.remove();
      toast(message, 'err', 5000);
    },
  };
}

/* ------------------------------------------------------------- drag/drop -- */

function bindDragDrop() {
  const zone = $('#workspace-drop');
  if (!zone) return;
  let depth = 0;
  const show = () => zone.classList.add('active');
  const hide = () => {
    depth = 0;
    zone.classList.remove('active');
  };
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    depth += 1;
    show();
  });
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hide();
  });
  window.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    hide();
    const files = [...event.dataTransfer.files];
    const zip = files.find((f) => f.name.toLowerCase().endsWith('.zip'));
    if (zip && files.length === 1) return importZipFile(zip);

    // A dropped folder arrives as an entry, not as File objects.
    const dropped = await filesFromDrop(event.dataTransfer).catch(() => []);
    const folders = dropped.filter((entry) => entry.path.includes('/'));
    if (folders.length) {
      const app = deps.getState();
      // Drop the shared top folder so `index.html` lands at the root, the way
      // an import is expected to behave.
      const roots = new Set(folders.map((entry) => entry.path.split('/')[0]));
      const strip = roots.size === 1 ? `${[...roots][0]}/` : '';
      const progress = showImportProgress([...roots][0] || 'folder');
      let written = 0;
      for (const [index, entry] of folders.entries()) {
        const path = strip && entry.path.startsWith(strip) ? entry.path.slice(strip.length) : entry.path;
        if (!path) continue;
        progress.set(index + 1, folders.length, path);
        try {
          await app.fs.write(app.project.id, path, isBinaryPath(path) ? new Uint8Array(await entry.file.arrayBuffer()) : await entry.file.text());
          written += 1;
        } catch (err) {
          console.warn('drop skip', path, err);
        }
      }
      progress.done(written);
      await refreshFileTree();
      deps.onFilesChanged?.({ source: 'drop' });
      toast(`Added ${written} file${written === 1 ? '' : 's'} from that folder`, 'ok', 4200);
      return;
    }
    await uploadFiles(files);
  });
  zone.querySelector('[data-drop-pick]')?.addEventListener('click', () => pickFiles());
}

/* ----------------------------------------------------------- folder mount -- */

/**
 * Connect a folder that already exists on this machine.
 *
 * The files are copied into the project so everything keeps working offline,
 * and every write in the app is mirrored back. The folder handle is remembered
 * in IndexedDB, so the connection survives a reload.
 */
export async function mountFolder({ handle: preset = null } = {}) {
  const app = deps.getState();
  if (!app?.project) return null;
  if (!preset && !supportsFolderMount()) {
    toast('This browser cannot open real folders — Chrome or Edge can. Drag a folder onto the window instead.', 'warn', 7000);
    return null;
  }
  let handle = preset;
  if (!handle) {
    try {
      handle = await pickFolder();
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'NotAllowedError') return null;
      toast(err.message || 'Could not open that folder', 'err', 6000);
      return null;
    }
  }
  const mount = new FolderMount({
    fs: app.fs,
    projectId: app.project.id,
    handle,
    onEvent: onMountEvent,
  });
  const granted = await mount.ensurePermission({ request: true });
  if (!granted) {
    toast('Write access to that folder was declined, so it cannot be mounted.', 'warn', 6000);
    return null;
  }

  const ok = await deps.confirm({
    title: `Mount “${handle.name}”?`,
    body: `Its files are copied into this project, and changes here are written straight back to the folder. Skip rules keep out node_modules, .git and build output. Up to ${MOUNT_LIMITS.files} files / ${Math.round(MOUNT_LIMITS.bytes / 1024 / 1024)} MB.`,
    confirm: 'Mount folder',
  });
  if (!ok) return null;

  const progress = showImportProgress(handle.name);
  try {
    const result = await mount.pullAll({
      onProgress: ({ path, index, total }) => {
        if (total) progress.set(index + 1, total, path);
      },
    });
    progress.done(result.written);
    state.mount = mount;
    // Remembering the handle is a convenience, not a requirement: some browsers
    // refuse to clone one (private mode, restricted storage) and the mount
    // itself must still work for this session.
    let remembered = true;
    await saveMountHandle(app.project.id, handle).catch(() => {
      remembered = false;
    });
    mount.watch();
    state.mountInfo = mount.info();
    renderMountBar();
    await refreshFileTree();
    deps.onFilesChanged?.({ source: 'mount' });
    toast(
      `Mounted ${handle.name} — ${result.written} file${result.written === 1 ? '' : 's'} copied${result.truncated ? ' (stopped at the size limit)' : ''}${remembered ? '' : ' · reconnect after a reload'}`,
      'ok',
      5200,
    );
    return mount;
  } catch (err) {
    progress.fail(err.message);
    toast(`Mount failed: ${err.message}`, 'err', 6000);
    return null;
  }
}

/** Reconnect the folder this project was mounted to, if the browser allows it. */
export async function resumeMount() {
  const app = deps.getState();
  if (!app?.project || state.mount) return null;
  const handle = await loadMountHandle(app.project.id).catch(() => null);
  if (!handle) return null;
  const mount = new FolderMount({ fs: app.fs, projectId: app.project.id, handle, onEvent: onMountEvent });
  const granted = await mount.ensurePermission({ request: false });
  state.mount = mount;
  state.mountInfo = { ...mount.info(), needsPermission: !granted };
  renderMountBar();
  if (granted) {
    mount.watch();
    await mount.pullChanges().catch(() => {});
    await refreshFileTree();
  }
  return mount;
}

export async function unmountFolder({ silent = false } = {}) {
  const app = deps.getState();
  const mount = state.mount;
  if (!mount) return;
  state.mount = null;
  state.mountInfo = null;
  try {
    await mount.flush();
  } catch {
    /* pending writes are best-effort */
  }
  mount.dispose();
  if (app?.project) await clearMountHandle(app.project.id).catch(() => {});
  renderMountBar();
  if (!silent) toast(`Disconnected ${mount.name}. The files stay in this project.`, 'info', 4200);
}

export async function syncMount(direction = 'pull') {
  const mount = state.mount;
  if (!mount) return null;
  const granted = await mount.ensurePermission({ request: true });
  if (!granted) {
    toast('Permission for that folder expired — reconnect it from the files pane.', 'warn', 6000);
    renderMountBar();
    return null;
  }
  const progress = showImportProgress(mount.name);
  try {
    if (direction === 'push') {
      const res = await mount.pushAll({ onProgress: ({ path, index, total }) => progress.set(index + 1, total, path) });
      progress.done(res.written);
      toast(`Wrote ${res.written} file${res.written === 1 ? '' : 's'} to ${mount.name}`, 'ok', 4200);
      return res;
    }
    const res = await mount.pullChanges({ onProgress: ({ path, index, total }) => progress.set(index + 1, total, path) });
    progress.done(res.written);
    await refreshFileTree();
    deps.onFilesChanged?.({ source: 'mount-pull' });
    toast(res.written ? `Pulled ${res.written} changed file${res.written === 1 ? '' : 's'} from ${mount.name}` : `${mount.name} is already up to date`, 'ok', 4200);
    return res;
  } catch (err) {
    progress.fail(err.message);
    toast(err.message, 'err', 5000);
    return null;
  }
}

export function mountInfo() {
  return state.mount ? { ...state.mount.info(), needsPermission: Boolean(state.mountInfo?.needsPermission) } : null;
}

function onMountEvent(event) {
  if (event.type === 'state') {
    state.mountInfo = state.mount ? state.mount.info() : null;
    renderMountBar();
  } else if (event.type === 'mirrored' && state.mount) {
    state.mountInfo = state.mount.info();
    renderMountBar();
  } else if (event.type === 'error') {
    console.warn('mount', event.path, event.message);
  }
}

/** The chip above the file tree: what is connected, and how fresh it is. */
function renderMountBar() {
  const host = $('#mount-bar');
  if (!host) return;
  const info = state.mount?.info();
  if (!info) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  const needs = state.mountInfo?.needsPermission;
  host.innerHTML = `<div class="mount-chip ${needs ? 'needs' : ''}">
      <span class="mount-dot ${info.state === 'syncing' ? 'busy' : needs ? 'paused' : 'live'}"></span>
      ${icon('hard-drive', 13)}
      <span class="mount-name" title="${escapeHtml(info.name)}">${escapeHtml(info.name)}</span>
      <span class="mount-meta">${needs ? 'reconnect' : info.state === 'syncing' ? 'syncing…' : `${info.files} files`}</span>
      <button class="icon-btn xs" data-mount-sync title="Pull changes from the folder" aria-label="Pull changes" ${needs ? 'disabled' : ''}>${icon('folder-sync', 13)}</button>
      <button class="icon-btn xs" data-mount-menu title="Folder options" aria-label="Folder options">${icon('more', 13)}</button>
    </div>`;
  host.querySelector('[data-mount-sync]')?.addEventListener('click', () => syncMount('pull'));
  host.querySelector('[data-mount-menu]')?.addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMountMenu(rect.left, rect.bottom + 4);
  });
}

function openMountMenu(x, y) {
  const mount = state.mount;
  if (!mount) return;
  document.querySelector('.ctx-menu')?.remove();
  const menu = el('div', { class: 'ctx-menu' });
  const action = (label, glyph, run, danger = false) => {
    const item = el('button', { class: `ctx-item ${danger ? 'danger' : ''}` });
    item.innerHTML = `${icon(glyph, 14)}<span>${label}</span>`;
    item.onclick = () => {
      menu.remove();
      run();
    };
    menu.append(item);
  };
  action('Pull changes from folder', 'folder-sync', () => syncMount('pull'));
  action('Write everything to folder', 'upload', () => syncMount('push'));
  action('Open the folder’s files', 'folder-open', () => document.querySelector('#file-tree')?.scrollIntoView({ block: 'start' }));
  action('Disconnect folder', 'unplug', () => unmountFolder(), true);
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  const close = (event) => {
    if (menu.contains(event.target)) return;
    menu.remove();
    document.removeEventListener('pointerdown', close);
  };
  setTimeout(() => document.addEventListener('pointerdown', close), 0);
}

/* ----------------------------------------------------------- dependencies -- */

/**
 * What `package.json` asks for, and whether it is actually on disk.
 *
 * This is the answer to "is my npm install real?" — visible without opening a
 * terminal, and one click away from running it when something is missing.
 */
async function readManifest() {
  const app = deps.getState();
  if (!app?.project) return null;
  try {
    const text = await app.fs.readText(app.project.id, 'package.json');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function installedVersions() {
  const out = new Map();
  for (const file of state.files) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(file.path);
    if (!match) continue;
    out.set(match[1], true);
  }
  return out;
}

async function renderDependencies() {
  const host = $('#deps-card');
  if (!host) return;
  const manifest = await readManifest();
  const deps = Object.entries({ ...(manifest?.dependencies || {}), ...(manifest?.devDependencies || {}) });
  if (!deps.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  const installed = installedVersions();
  const missing = deps.filter(([name]) => !installed.has(name));
  host.hidden = false;
  host.innerHTML = `<button class="deps-head" aria-expanded="${state.depsOpen}">
      ${icon(state.depsOpen ? 'chevron-down' : 'chevron-right', 12)}
      ${icon('package', 13)}
      <span>Packages</span>
      <span class="deps-count ${missing.length ? 'warn' : ''}">${deps.length - missing.length}/${deps.length}</span>
      ${missing.length ? `<span class="deps-action" data-deps-install title="npm install">${icon('download', 12)} install</span>` : ''}
    </button>
    <div class="deps-list" ${state.depsOpen ? '' : 'hidden'}>
      ${deps
        .map(
          ([name, range]) => `<div class="deps-row ${installed.has(name) ? 'ok' : 'missing'}">
            <span class="ft ft-modules">${icon(installed.has(name) ? 'box' : 'warn', 12)}</span>
            <span class="deps-name">${escapeHtml(name)}</span>
            <span class="deps-range">${escapeHtml(String(range))}</span>
          </div>`,
        )
        .join('')}
    </div>`;
  host.querySelector('.deps-head').onclick = () => {
    state.depsOpen = !state.depsOpen;
    renderDependencies();
  };
  host.querySelector('[data-deps-install]')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    deps.setView('terminal');
    await deps.runCommand?.('npm install');
  });
}

/* -------------------------------------------------------------- toolbar --- */

function bindToolbar() {
  const on = (selector, handler) => {
    const node = $(selector);
    if (node) node.onclick = handler;
  };
  on('#btn-add', () => toggleAddMenu());
  on('#btn-download-project', () => downloadProjectZip());
  on('#btn-collapse-tree', () => document.querySelector('#view-files')?.classList.toggle('tree-hidden'));
  const search = $('#file-search');
  if (search) {
    search.oninput = () => {
      state.filter = search.value;
      renderTree();
    };
    search.onkeydown = (event) => {
      if (event.key === 'Escape') {
        search.value = '';
        state.filter = '';
        renderTree();
        search.blur();
      }
    };
  }
}

/** Everything that adds to the workspace lives behind one button. */
function toggleAddMenu(force) {
  const menu = $('#add-menu');
  const button = $('#btn-add');
  if (!menu || !button) return;
  const open = force ?? menu.hidden;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  menu.innerHTML = '';
  if (!open) return;

  // Anchor under the button, but measure first: on a phone the toolbar is
  // narrower than the menu, and `right: 0` alone pushed it off the left edge.
  menu.style.position = 'fixed';
  const anchor = button.getBoundingClientRect();
  const width = Math.min(268, window.innerWidth - 24);
  menu.style.width = `${width}px`;
  const left = Math.min(Math.max(12, anchor.right - width), window.innerWidth - width - 12);
  menu.style.left = `${left}px`;
  menu.style.right = 'auto';
  menu.style.top = `${Math.round(anchor.bottom + 6)}px`;

  const item = (label, glyph, hint, run) => {
    const node = el('button', { class: 'ctx-item', role: 'menuitem' });
    node.innerHTML = `${icon(glyph, 14)}<span class="ctx-label">${label}${hint ? `<em>${hint}</em>` : ''}</span>`;
    node.onclick = () => {
      toggleAddMenu(false);
      run();
    };
    menu.append(node);
  };
  item('New file', 'file', 'or a path like src/app.js', () => newFile());
  item('Upload files', 'upload', '', () => pickFiles());
  item('Mount a folder…', 'folder-plus', supportsFolderMount() ? 'connect a real folder' : 'needs Chrome or Edge', () => mountFolder());
  item('Import a repository…', 'github', 'owner/repo', () => importRepo());

  const close = (event) => {
    if (menu.contains(event.target) || button.contains(event.target)) return;
    toggleAddMenu(false);
    document.removeEventListener('pointerdown', close);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      toggleAddMenu(false);
      button.focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;
    const filesViewVisible = $('#view-files')?.classList.contains('active');
    if (event.key.toLowerCase() === 's') {
      if (!filesViewVisible) return;
      event.preventDefault();
      saveActiveFile();
    } else if (event.key.toLowerCase() === 'p' && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      $('#file-search')?.focus();
    }
  });
}

/* ------------------------------------------------------------ agent sync -- */

/** If the agent rewrote the open file, reload it — but never clobber typing. */
async function syncOpenWithDisk() {
  const app = deps.getState();
  if (!app.project) return;
  for (const entry of state.open) {
    if (entry.dirty) continue;
    let text;
    try {
      text = await app.fs.readText(app.project.id, entry.path);
    } catch {
      continue;
    }
    if (text !== entry.saved) {
      entry.text = text;
      entry.saved = text;
      if (entry.path === state.active) renderEditor();
    }
  }
}

export function activeFile() {
  return state.open.find((f) => f.path === state.active) || null;
}

export function openPaths() {
  return state.open.map((f) => f.path);
}
