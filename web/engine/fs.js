/**
 * Project filesystem.
 *
 * Primary backend: OPFS (Origin Private File System) — real files, real
 * directories, survives reloads, and is what a browser-based IDE should use.
 * Fallback: IndexedDB-backed flat map (Safari < 16.4, workers-less contexts).
 * Test backend: memory.
 *
 * Every path is project-scoped: "/index.html" inside project p_ab12. There is
 * no way to reach another project or the host — the browser origin private
 * filesystem already gives us that boundary, and we normalise paths on top.
 */

const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Directories with no project meaning. `node_modules` is deliberately *not*
// here: an installed package has to be visible to the file tree, the editor and
// the folder mount, or `npm install` looks like it did nothing. Consumers that
// do not want it (the agent's snapshot, the preview bundle) filter it out.
const IGNORE = new Set(['.git', '.cache', '.next', '__pycache__', '.venv']);
const MAX_LISTED = 12000;

export function normPath(input) {
  let p = String(input ?? '').replace(/\\/g, '/').trim();
  if (!p) return '';
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new Error('Path escapes the project root');
      parts.pop();
      continue;
    }
    if (seg.length > 200) throw new Error('Path segment too long');
    parts.push(seg);
  }
  return parts.join('/');
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function extname(p) {
  const base = p.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
export const mimeFor = (p) => MIME[extname(p)] || 'application/octet-stream';
export const isBinaryPath = (p) => /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|mp4|zip|wasm|sqlite|db)$/i.test(p);

export class MemoryFs {
  constructor() {
    this.files = new Map();
    this.mode = 'memory';
  }
  async write(project, path, content) {
    this.files.set(`${project}/${path}`, { content, updatedAt: Date.now() });
  }
  async read(project, path) {
    const hit = this.files.get(`${project}/${path}`);
    if (!hit) throw new Error(`ENOENT: ${path}`);
    return hit.content;
  }
  async list(project) {
    const prefix = `${project}/`;
    return [...this.files.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ path: k.slice(prefix.length), size: String(this.files.get(k).content ?? '').length, updatedAt: this.files.get(k).updatedAt }));
  }
  async remove(project, path) {
    for (const key of [...this.files.keys()]) {
      if (key === `${project}/${path}` || key.startsWith(`${project}/${path}/`)) this.files.delete(key);
    }
  }
  async move(project, from, to) {
    const hit = this.files.get(`${project}/${from}`);
    if (!hit) throw new Error(`ENOENT: ${from}`);
    this.files.delete(`${project}/${from}`);
    this.files.set(`${project}/${to}`, hit);
  }
}

/**
 * IndexedDB backend: a flat path map. Slower than OPFS for big trees, but it
 * persists everywhere (including browsers that block OPFS inside a
 * partitioned third-party frame), so files survive a reload.
 */
export class IdbFs {
  constructor(dbName = 'alphacode-fs') {
    this.dbName = dbName;
    this.dbp = null;
    this.mode = 'indexeddb';
  }
  open() {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked (another tab is holding an old version)'));
      });
    }
    return this.dbp;
  }
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const store = tx.objectStore('files');
      let result;
      try {
        result = fn(store);
      } catch (err) {
        return reject(err);
      }
      tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted (storage full?)'));
    });
  }
  async write(project, path, content) {
    const value = typeof content === 'string' ? content : content instanceof ArrayBuffer ? new Uint8Array(content) : content;
    await this.tx('readwrite', (store) => store.put({ content: value, updatedAt: Date.now() }, `${project}/${path}`));
  }
  async read(project, path) {
    const row = await this.tx('readonly', (store) => ({ __req: store.get(`${project}/${path}`) }));
    if (!row) throw new Error(`ENOENT: ${path}`);
    return row.content;
  }
  async list(project) {
    const prefix = `${project}/`;
    const rows = await this.tx('readonly', (store) => ({ __req: store.getAllKeys() }));
    const out = [];
    for (const key of rows || []) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        const value = await this.read(project, key.slice(prefix.length));
        out.push({
          path: key.slice(prefix.length),
          size: typeof value === 'string' ? value.length : value?.byteLength || value?.size || 0,
          updatedAt: 0,
        });
      }
    }
    return out;
  }
  async remove(project, path) {
    const prefix = `${project}/`;
    const keys = await this.tx('readonly', (store) => ({ __req: store.getAllKeys() }));
    const victims = (keys || []).filter((k) => k === `${prefix}${path}` || k.startsWith(`${prefix}${path}/`));
    if (!victims.length) return;
    await this.tx('readwrite', (store) => {
      for (const k of victims) store.delete(k);
    });
  }
  async move(project, from, to) {
    const row = await this.tx('readonly', (store) => ({ __req: store.get(`${project}/${from}`) }));
    if (!row) throw new Error(`ENOENT: ${from}`);
    await this.write(project, to, row.content);
    await this.tx('readwrite', (store) => store.delete(`${project}/${from}`));
  }
}

export class OpfsFs {
  constructor() {
    this.root = null;
    this.mode = 'opfs';
  }
  async dir(project, { create = true } = {}) {
    if (!this.root) this.root = await navigator.storage.getDirectory();
    const projects = await this.root.getDirectoryHandle('projects', { create: true });
    return projects.getDirectoryHandle(project, { create });
  }
  async fileHandle(project, path, { create = false } = {}) {
    const segments = path.split('/');
    const name = segments.pop();
    let dir = await this.dir(project, { create });
    for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create });
    return { dir, handle: await dir.getFileHandle(name, { create }) };
  }
  async write(project, path, content) {
    const { handle } = await this.fileHandle(project, path, { create: true });
    const stream = await handle.createWritable();
    await stream.write(content);
    await stream.close();
  }
  async read(project, path) {
    const { handle } = await this.fileHandle(project, path);
    const file = await handle.getFile();
    return isBinaryPath(path) ? file.arrayBuffer() : file.text();
  }
  async list(project) {
    const out = [];
    const walk = async (dir, prefix) => {
      for await (const [name, entry] of dir.entries()) {
        if (IGNORE.has(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === 'directory') await walk(entry, path);
        else {
          const file = await entry.getFile();
          out.push({ path, size: file.size, updatedAt: file.lastModified });
        }
        if (out.length > MAX_LISTED) return;
      }
    };
    try {
      await walk(await this.dir(project, { create: false }), '');
    } catch {
      /* project has no directory yet */
    }
    return out;
  }
  async remove(project, path) {
    const parent = await this.fileHandle(project, path).then((r) => r.dir).catch(() => null);
    if (!parent) return;
    await parent.removeEntry(path.split('/').pop(), { recursive: true });
  }
  async move(project, from, to) {
    const content = await this.read(project, from);
    await this.write(project, to, content);
    await this.remove(project, from);
  }
}

export class FileSystem {
  constructor(backend) {
    this.backend = backend;
    this.listeners = new Set();
    this.suspended = 0;
  }

  /**
   * Watch every write, delete and move.
   *
   * The folder mount, the preview reload and the file tree all want to know
   * about the same event, and they all want it synchronously — so this is a
   * plain listener list, not a pub/sub bus.
   *
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Stop reporting changes (used while a mount writes its own files back). */
  mute() {
    this.suspended += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.suspended = Math.max(0, this.suspended - 1);
    };
  }

  emit(event) {
    if (this.suspended) return;
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a broken listener must not break a write */
      }
    }
  }

  /** 'opfs' | 'indexeddb' | 'memory' — where these files actually live. */
  get mode() {
    return this.backend?.mode || 'memory';
  }

  async write(projectId, rawPath, content) {
    const path = normPath(rawPath);
    if (!path) throw new Error('A file path is required');
    const text = typeof content === 'string' ? content : String(content ?? '');
    if (text.length > MAX_FILE_BYTES) throw new Error(`File too large (${text.length} bytes > ${MAX_FILE_BYTES})`);
    await this.backend.write(projectId, path, content);
    const size = typeof content === 'string' ? text.length : content.byteLength || 0;
    this.emit({ type: 'write', projectId, path, size });
    return { path, bytes: size };
  }

  async read(projectId, rawPath) {
    const path = normPath(rawPath);
    return this.backend.read(projectId, path);
  }

  async readText(projectId, rawPath) {
    const value = await this.read(projectId, rawPath);
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  }

  /**
   * Every text file as `{ path: contents }` — the shape the harness, the Node
   * runtime and the preview builder all want. Binary and huge files are skipped
   * so one dropped archive cannot blow up a turn.
   */
  async snapshot(projectId, { includeModules = false, maxFiles = 2000 } = {}) {
    const files = await this.list(projectId);
    const out = {};
    let count = 0;
    for (const file of files) {
      if (count >= maxFiles) break;
      if (!includeModules && file.path.startsWith('node_modules/')) continue;
      if (isBinaryPath(file.path)) continue;
      if ((file.size || 0) > 2_000_000) continue;
      try {
        out[file.path] = await this.readText(projectId, file.path);
        count += 1;
      } catch {
        /* file vanished mid-listing — skip it */
      }
    }
    return out;
  }

  /** Replace the project contents with `files` (used by restores). */
  async restore(projectId, files) {
    const existing = await this.list(projectId).catch(() => []);
    for (const file of existing) {
      if (!(file.path in files) && !file.path.startsWith('node_modules/')) {
        await this.remove(projectId, file.path).catch(() => {});
      }
    }
    for (const [path, content] of Object.entries(files || {})) {
      await this.write(projectId, path, content);
    }
    return Object.keys(files || {}).length;
  }

  /** A nested tree for the file panel: `[{ name, path, dir, children }]`. */
  async tree(projectId, { showModules = false } = {}) {
    const files = await this.list(projectId);
    const root = [];
    for (const file of files) {
      if (!showModules && file.path.startsWith('node_modules/')) continue;
      const parts = file.path.split('/');
      let level = root;
      let prefix = '';
      for (let i = 0; i < parts.length; i += 1) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        const isLeaf = i === parts.length - 1;
        let node = level.find((entry) => entry.name === parts[i] && entry.dir === !isLeaf);
        if (!node) {
          node = isLeaf
            ? { name: parts[i], path: prefix, dir: false, size: file.size || 0 }
            : { name: parts[i], path: prefix, dir: true, children: [] };
          level.push(node);
        }
        if (!isLeaf) level = node.children;
      }
    }
    const sort = (nodes) => {
      nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      for (const node of nodes) if (node.children) sort(node.children);
      return nodes;
    };
    return sort(root);
  }

  async exists(projectId, rawPath) {
    try {
      await this.backend.read(projectId, normPath(rawPath));
      return true;
    } catch {
      return false;
    }
  }

  async list(projectId, { includeModules = true } = {}) {
    const files = await this.backend.list(projectId);
    const filtered = includeModules ? files : files.filter((file) => !file.path.startsWith('node_modules/'));
    return filtered.sort((a, b) => a.path.localeCompare(b.path));
  }

  async remove(projectId, rawPath) {
    const path = normPath(rawPath);
    await this.backend.remove(projectId, path);
    this.emit({ type: 'remove', projectId, path });
  }

  async move(projectId, from, to) {
    const a = normPath(from);
    const b = normPath(to);
    await this.backend.move(projectId, a, b);
    this.emit({ type: 'move', projectId, from: a, to: b });
  }

  /** glob: **, *, ?, {a,b} — same semantics as the server-side tool. */
  async find(projectId, pattern = '**/*', { limit = 300 } = {}) {
    const files = await this.list(projectId);
    const re = globToRegExp(pattern);
    return files.map((f) => f.path).filter((p) => re.test(p)).slice(0, limit);
  }

  /** grep across text files. */
  async search(projectId, pattern, { glob = '', limit = 200, regex = true, caseSensitive = false } = {}) {
    const files = await this.list(projectId);
    const globRe = glob ? globToRegExp(glob) : null;
    let re;
    try {
      re = new RegExp(pattern, `${caseSensitive ? '' : 'i'}g`);
    } catch (err) {
      throw new Error(`Invalid pattern: ${err.message}`);
    }
    const out = [];
    for (const f of files) {
      if (globRe && !globRe.test(f.path)) continue;
      if (isBinaryPath(f.path) || f.size > 1_000_000) continue;
      let text;
      try {
        text = await this.readText(projectId, f.path);
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          out.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 300) });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  async tree(projectId, { maxDepth = 6, maxFiles = 900 } = {}) {
    const files = await this.list(projectId);
    const dirs = new Set();
    for (const f of files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const nodes = [
      ...[...dirs].map((path) => ({ path, dir: true, depth: path.split('/').length - 1 })),
      ...files.map((f) => ({ path: f.path, dir: false, size: f.size, depth: f.path.split('/').length - 1, updatedAt: f.updatedAt })),
    ];
    return nodes.filter((n) => n.depth < maxDepth).sort((a, b) => a.path.localeCompare(b.path)).slice(0, maxFiles);
  }

  async snapshot(projectId) {
    const files = {};
    for (const f of await this.list(projectId)) {
      if (isBinaryPath(f.path) || f.size > 512_000) continue;
      try {
        files[f.path] = await this.readText(projectId, f.path);
      } catch {
        /* ignore */
      }
    }
    return files;
  }

  async restore(projectId, snapshot) {
    for (const [path, content] of Object.entries(snapshot || {})) {
      await this.write(projectId, path, content);
    }
  }
}

/** Convert a glob to an anchored RegExp (**, *, ?, {a,b}). */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      } else re += '\\{';
    } else if ('\\^$+.()|[]'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function createFs({ backend } = {}) {
  if (backend) return new FileSystem(backend);
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) return new FileSystem(new OpfsFs());
  if (typeof indexedDB !== 'undefined') return new FileSystem(new IdbFs());
  return new FileSystem(new MemoryFs());
}

/**
 * Pick the best storage that *actually works here*, not just one whose API
 * exists. OPFS throws inside partitioned/sandboxed frames even though
 * navigator.storage.getDirectory is defined, so probe with a real write.
 */
export async function createFsAsync({ prefer = 'opfs' } = {}) {
  if (prefer === 'opfs' && typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    const fs = new FileSystem(new OpfsFs());
    try {
      const probe = `probe-${Math.random().toString(36).slice(2)}`;
      await fs.write('__probe__', 'ok.txt', 'ok');
      await fs.readText('__probe__', 'ok.txt');
      await fs.remove('__probe__', 'ok.txt');
      return fs;
    } catch {
      /* fall through to IndexedDB */
    }
  }
  if (typeof indexedDB !== 'undefined') {
    try {
      const fs = new FileSystem(new IdbFs());
      await fs.write('__probe__', 'ok.txt', 'ok');
      await fs.readText('__probe__', 'ok.txt');
      await fs.remove('__probe__', 'ok.txt');
      return fs;
    } catch {
      /* fall through to memory */
    }
  }
  return new FileSystem(new MemoryFs());
}
