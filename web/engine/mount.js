/**
 * Mount a folder that already exists on the machine.
 *
 * The File System Access API gives a page a durable handle to a real directory:
 * read it, write into it, and get it back on the next visit. That is what makes
 * AlphaCode usable on a project someone already has, instead of only on files
 * that were born in the tab.
 *
 * The project keeps its own copy. Every file is mirrored into local storage so
 * the editor, the preview, the agent and the Node runtime all keep working
 * while the folder is disconnected, and every write in the app is pushed back
 * out to the folder. Two-way, with the folder as the one the user can see.
 *
 * Nothing here touches `window` at import time: the handle is injected, so the
 * sync logic is testable against a plain object.
 */

/** Directories that are never worth pulling in on a first mount. */
export const MOUNT_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', '.turbo', '.venv', '__pycache__', '.DS_Store']);

export const MOUNT_LIMITS = { files: 5000, bytes: 64 * 1024 * 1024 };

/** Is the browser capable of mounting a real folder? */
export function supportsFolderMount(target = typeof window !== 'undefined' ? window : globalThis) {
  return typeof target?.showDirectoryPicker === 'function';
}

/** Ask the user for a folder. Must be called from a user gesture. */
export async function pickFolder({ mode = 'readwrite', startIn = undefined } = {}) {
  if (!supportsFolderMount()) {
    const err = new Error('This browser cannot open a folder. Chrome, Edge and other Chromium browsers can.');
    err.code = 'UNSUPPORTED';
    throw err;
  }
  const options = { mode };
  if (startIn) options.startIn = startIn;
  return window.showDirectoryPicker(options);
}

/* --------------------------------------------------------------- walking -- */

const isSkipped = (path, skip) => {
  for (const part of path.split('/')) if (skip.has(part)) return true;
  return false;
};

/**
 * Walk a directory handle.
 *
 * The API is async at the directory level and sync at the file level, so this
 * collects `{ path, handle, size, lastModified }` and lets the caller decide
 * what to read — importing a big folder should be able to stop early.
 */
export async function walkFolder(root, { skip = MOUNT_SKIP_DIRS, limit = MOUNT_LIMITS.files, onProgress = () => {}, signal } = {}) {
  const out = [];
  const queue = [['', root]];
  let bytes = 0;
  let truncated = false;

  while (queue.length) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const [prefix, dir] = queue.shift();
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (isSkipped(path, skip)) continue;
      if (handle.kind === 'directory') {
        queue.push([path, handle]);
        onProgress({ path, files: out.length });
        continue;
      }
      let file;
      try {
        file = await handle.getFile();
      } catch {
        continue; // vanished, or the permission was withdrawn mid-walk
      }
      out.push({ path, handle, size: file.size, lastModified: file.lastModified });
      bytes += file.size;
      if (out.length > limit || bytes > MOUNT_LIMITS.bytes) {
        truncated = true;
        queue.length = 0;
        break;
      }
    }
  }
  return { files: out, bytes, truncated };
}

/** Read a file handle as text or bytes, matching how the store wants it. */
export async function readHandle(handle, path) {
  const file = await handle.getFile();
  if (isTextPath(path)) return file.text();
  return new Uint8Array(await file.arrayBuffer());
}

const TEXT_FILE = /\.(html?|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|mdx|txt|yml|yaml|toml|ini|env|conf|config|svg|xml|csv|sql|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|bash|zsh|gitignore|npmrc|lock|map|vue|svelte|astro|graphql|prisma)$/i;
const TEXT_NAMES = new Set(['LICENSE', 'LICENCE', 'README', 'CHANGELOG', 'Dockerfile', 'Procfile', 'Makefile']);

export function isTextPath(path) {
  const name = String(path).split('/').pop() || '';
  if (TEXT_NAMES.has(name)) return true;
  if (name.startsWith('.')) return true;
  return TEXT_FILE.test(name);
}

/* ------------------------------------------------------------- the mount -- */

export class FolderMount {
  /**
   * @param {object} options
   * @param {import('./fs.js').FileSystem} options.fs
   * @param {string} options.projectId
   * @param {object} options.handle   a FileSystemDirectoryHandle (or a stand-in)
   * @param {(event: object) => void} [options.onEvent]
   */
  constructor({ fs, projectId, handle, onEvent = () => {} }) {
    this.fs = fs;
    this.projectId = projectId;
    this.handle = handle;
    this.onEvent = onEvent;
    this.name = handle?.name || 'folder';
    this.index = new Map(); // path -> { size, lastModified }
    this.state = 'idle'; // idle | syncing | ready | error
    this.lastSyncAt = 0;
    this.unsubscribe = null;
    this.queue = new Set();
    this.timer = null;
    this.syncing = null;
  }

  info() {
    return {
      name: this.name,
      state: this.state,
      files: this.index.size,
      lastSyncAt: this.lastSyncAt,
      supported: true,
    };
  }

  /** Ask for (or refresh) write permission on the handle we already have. */
  async ensurePermission({ request = false } = {}) {
    const opts = { mode: 'readwrite' };
    if (!this.handle?.queryPermission) return true; // stand-in handle: assume yes
    let status = await this.handle.queryPermission(opts);
    if (status !== 'granted' && request && this.handle.requestPermission) {
      status = await this.handle.requestPermission(opts);
    }
    return status === 'granted';
  }

  /**
   * Copy the folder into the project.
   *
   * `skip` defaults to the build directories; pass an empty set to take
   * everything. Files that are already identical on both sides are not
   * rewritten, so re-mounting is cheap.
   */
  async pullAll({ skip = MOUNT_SKIP_DIRS, onProgress = () => {}, signal } = {}) {
    this.setState('syncing');
    const { files, truncated, bytes } = await walkFolder(this.handle, { skip, onProgress, signal });
    let written = 0;
    const release = this.fs.mute?.(); // our own writes are not mount events
    try {
      for (const [i, entry] of files.entries()) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        onProgress({ path: entry.path, index: i, total: files.length });
        const known = this.index.get(entry.path);
        const unchanged = known && known.size === entry.size && known.lastModified === entry.lastModified;
        const exists = await this.fs.exists(this.projectId, entry.path).catch(() => false);
        if (!unchanged || !exists) {
          const content = await readHandle(entry.handle, entry.path);
          await this.fs.write(this.projectId, entry.path, content);
          written += 1;
        }
        this.index.set(entry.path, { size: entry.size, lastModified: entry.lastModified });
      }
    } finally {
      release?.();
    }
    this.lastSyncAt = Date.now();
    this.setState('ready');
    this.emit({ type: 'pulled', written, total: files.length, bytes, truncated });
    return { written, total: files.length, bytes, truncated };
  }

  /** Pick up files edited on disk since the last pull. */
  async pullChanges({ onProgress = () => {}, signal } = {}) {
    this.setState('syncing');
    const { files } = await walkFolder(this.handle, { onProgress });
    const changed = [];
    const seen = new Set();
    for (const entry of files) {
      seen.add(entry.path);
      const known = this.index.get(entry.path);
      if (!known || known.size !== entry.size || known.lastModified !== entry.lastModified) changed.push(entry);
    }
    const removed = [...this.index.keys()].filter((p) => !seen.has(p));
    let written = 0;
    const release = this.fs.mute?.();
    try {
      for (const entry of changed) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        const content = await readHandle(entry.handle, entry.path);
        await this.fs.write(this.projectId, entry.path, content);
        this.index.set(entry.path, { size: entry.size, lastModified: entry.lastModified });
        written += 1;
      }
      for (const path of removed) this.index.delete(path);
    } finally {
      release?.();
    }
    this.lastSyncAt = Date.now();
    this.setState('ready');
    this.emit({ type: 'pulled', written, removed: removed.length, total: files.length });
    return { written, removed, total: files.length };
  }

  /** Write one project file into the folder (creating folders as needed). */
  async pushPath(path, { force = false } = {}) {
    if (isSkipped(path, new Set(['.git']))) return false;
    const content = await this.fs.read(this.projectId, path).catch(() => null);
    if (content === null) return false;
    const { dir, name } = await this.dirFor(path, { create: true });
    if (!dir) return false;
    const handle = await dir.getFileHandle(name, { create: true });

    if (!force) {
      // Identical size on both sides is good enough to skip a rewrite: a file
      // that changed in the app changed size in almost every real edit.
      try {
        const existing = await handle.getFile();
        const size = typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength || 0;
        if (existing.size === size && this.index.get(path)?.size === size) return false;
      } catch {
        /* new file */
      }
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    const stamp = Date.now();
    this.index.set(path, { size: typeof content === 'string' ? content.length : content.byteLength || 0, lastModified: stamp });
    return true;
  }

  async dirFor(path, { create = false } = {}) {
    const parts = String(path).split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) return { dir: null, name: '' };
    let dir = this.handle;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch {
        return { dir: null, name };
      }
    }
    return { dir, name };
  }

  /** Write every project file to the folder. */
  async pushAll({ onProgress = () => {}, includeModules = true, signal } = {}) {
    this.setState('syncing');
    const files = await this.fs.list(this.projectId);
    let written = 0;
    let skipped = 0;
    for (const [i, file] of files.entries()) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (!includeModules && file.path.startsWith('node_modules/')) continue;
      onProgress({ path: file.path, index: i, total: files.length });
      try {
        if (await this.pushPath(file.path, { force: true })) written += 1;
        else skipped += 1;
      } catch (err) {
        this.emit({ type: 'error', path: file.path, message: err.message });
      }
    }
    this.lastSyncAt = Date.now();
    this.setState('ready');
    this.emit({ type: 'pushed', written, skipped, total: files.length });
    return { written, skipped, total: files.length };
  }

  /**
   * Mirror every write the app makes into the folder.
   *
   * Writes are batched: an `npm install` writes thousands of files and one
   * `createWritable` per file is the slow part, so the queue drains in small
   * groups and reports progress instead of blocking the UI.
   */
  watch({ includeModules = true } = {}) {
    this.unwatch();
    this.unwatchFn = this.fs.onChange?.((event) => {
      if (event.projectId !== this.projectId) return;
      if (event.type !== 'write') return;
      if (!includeModules && event.path.startsWith('node_modules/')) return;
      this.queue.add(event.path);
      this.schedule();
    });
    return () => this.unwatch();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, 400);
  }

  async drain() {
    if (this.syncing) return this.syncing;
    if (!this.queue.size) return null;
    // Take from the set itself: spreading it first would leave the paths in
    // the queue and the drain loop would never finish.
    const batch = [];
    for (const path of this.queue) {
      if (batch.length >= 60) break;
      batch.push(path);
    }
    for (const path of batch) this.queue.delete(path);
    this.syncing = (async () => {
      let written = 0;
      for (const path of batch) {
        try {
          if (await this.pushPath(path)) written += 1;
        } catch (err) {
          this.emit({ type: 'error', path, message: err.message });
        }
      }
      if (written) this.emit({ type: 'mirrored', written });
      if (this.queue.size) this.schedule();
      this.syncing = null;
      return written;
    })();
    return this.syncing;
  }

  /** Wait until the write queue is empty (used before unmounting). */
  async flush({ maxRounds = 200 } = {}) {
    let rounds = 0;
    while ((this.queue.size || this.syncing) && rounds < maxRounds) {
      rounds += 1;
      if (this.syncing) await this.syncing;
      else await this.drain();
    }
    return { pending: this.queue.size };
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'state', state });
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch {
      /* a UI callback must not break the sync */
    }
  }

  unwatch() {
    this.unwatchFn?.();
    this.unwatchFn = null;
  }

  dispose() {
    this.unwatchFn?.();
    this.unwatchFn = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.clear();
  }
}

/* ------------------------------------------------------ handle persistence -- */

const DB_NAME = 'alphacode-handles';
const STORE = 'handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * File handles are structured-cloneable, so IndexedDB can remember one across
 * reloads. That is the whole point of the feature: the folder stays connected.
 */
export async function saveMountHandle(projectId, handle) {
  if (typeof indexedDB === 'undefined' || !handle) return false;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, `mount:${projectId}`);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return true;
}

export async function loadMountHandle(projectId) {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDb();
  const handle = await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(`mount:${projectId}`);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return handle;
}

export async function clearMountHandle(projectId) {
  if (typeof indexedDB === 'undefined') return false;
  const db = await openDb();
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(`mount:${projectId}`);
    tx.oncomplete = resolve;
    tx.onerror = () => resolve();
  });
  db.close();
  return true;
}

/**
 * Drag-and-drop of a *folder*: the data transfer carries an entry API that
 * Chromium and Firefox both implement. It copies the files once instead of
 * keeping them connected, which is the honest fallback where the File System
 * Access API is missing.
 */
export async function filesFromDrop(dataTransfer, { skip = MOUNT_SKIP_DIRS } = {}) {
  const entries = [];
  const items = dataTransfer?.items;
  if (!items) return entries;
  const roots = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const walkEntry = async (entry, prefix = '') => {
    if (skip.has(entry.name) && !prefix) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      for (const child of children) await walkEntry(child, path);
      return;
    }
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (file) entries.push({ path, file });
  };
  for (const root of roots) await walkEntry(root);
  return entries;
}
