/**
 * The code workspace: a file tree you can actually operate, and an editor with
 * tabs, line numbers, autosave and a real undo history.
 *
 * Everything here talks to the app through `deps` so the agent loop in main.js
 * stays readable. The point of the module is that a person can *work* in it:
 * create, rename, delete, upload, download, import a ZIP, edit without losing
 * changes, and see what the agent changed underneath them.
 */
import { $, el, icon, escapeHtml, bytes, toast } from './ui.js';
import { isBinaryPath } from '../engine/fs.js';
import { zipSync, download } from '../engine/zip.js';
import { unzipSync } from 'fflate';

const deps = {};
const state = {
  files: [],
  open: [], // [{ path, text, saved, dirty, scroll, cursor }]
  active: null,
  filter: '',
  lastClick: null,
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
  syncOpenWithDisk();
}

function renderTree() {
  const host = $('#file-tree');
  if (!host) return;
  const query = state.filter.trim().toLowerCase();
  const files = state.files.filter((f) => !query || f.path.toLowerCase().includes(query));
  host.innerHTML = '';

  if (!state.files.length) {
    host.innerHTML = `<div class="tree-empty">
      <span class="tree-empty-icon">${icon('files', 20)}</span>
      <p>No files yet.</p>
      <p class="hint">Ask the agent to build something, drop files here, or create one.</p>
      <div class="tree-empty-actions">
        <button class="btn sm" data-empty-new>${icon('plus', 13)} New file</button>
        <button class="btn sm" data-empty-upload>${icon('upload', 13)} Upload</button>
        <button class="btn sm" data-empty-repo>${icon('github', 13)} Import repo</button>
      </div>
    </div>`;
    host.querySelector('[data-empty-new]').onclick = () => newFile();
    host.querySelector('[data-empty-upload]').onclick = () => pickFiles();
    host.querySelector('[data-empty-repo]').onclick = () => importRepo();
    return;
  }

  if (!files.length) {
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
      const head = el('div', { class: 'tree-group', html: `${icon('folder', 12)}<span>${escapeHtml(group)}</span>` });
      host.append(head);
    }
    for (const file of groups.get(group).sort((a, b) => a.path.localeCompare(b.path))) {
      host.append(treeNode(file, group ? 1 : 0));
    }
  }
}

function treeNode(file, depth) {
  const name = file.path.split('/').pop();
  const row = el('div', {
    class: `tree-row ${file.path === state.active ? 'active' : ''} ${file.path === state.lastClick ? 'flash' : ''}`,
  });
  row.style.paddingLeft = `${8 + depth * 10}px`;
  const binary = isBinaryPath(file.path);
  row.innerHTML = `${icon(binary ? 'package' : 'file', 13)}<span class="path">${escapeHtml(name)}</span><span class="size">${bytes(file.size || 0)}</span>
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
    await uploadFiles(files);
  });
  zone.querySelector('[data-drop-pick]')?.addEventListener('click', () => pickFiles());
}

/* -------------------------------------------------------------- toolbar --- */

function bindToolbar() {
  const on = (selector, handler) => {
    const node = $(selector);
    if (node) node.onclick = handler;
  };
  on('#btn-new-file', () => newFile());
  on('#btn-upload-files', () => pickFiles());
  on('#btn-import-repo', () => importRepo());
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
