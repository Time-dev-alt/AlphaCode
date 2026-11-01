/**
 * The filesystem the Node runtime sees.
 *
 * Node's API is synchronous, the browser's storage is not, so the runtime works
 * on an in-memory mirror of the project (hydrated once when the runtime starts)
 * and writes are flushed back to OPFS/IndexedDB by the job loop. That gives the
 * tab real `fs.readFileSync`, which is what npm packages actually need.
 *
 * Everything is path-jailed to the project: `/etc/passwd` inside the runtime is
 * simply a file that does not exist.
 */

export class NodeFS {
  constructor({ cwd = '/app' } = {}) {
    this.cwd = cwd;
    this.files = new Map(); // abs path -> { data: Uint8Array, mtime, mode }
    this.dirs = new Set(['/']);
    this.dirty = new Set();
    this.removed = new Set();
    this.root = cwd;
  }

  /* ------------------------------------------------------------ helpers -- */

  normalize(p, base = this.cwd) {
    let input = String(p ?? '');
    if (!input) return this.cwd;
    if (input.startsWith('file://')) input = new URL(input).pathname;
    if (!input.startsWith('/')) input = `${base.replace(/\/+$/, '')}/${input}`;
    const parts = [];
    for (const seg of input.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (parts.length) parts.pop();
        continue;
      }
      parts.push(seg);
    }
    return `/${parts.join('/')}`;
  }

  /** Map an absolute runtime path to the project-relative path used by the app. */
  toProjectPath(abs) {
    const root = this.root === '/' ? '' : this.root;
    if (abs === this.root) return '';
    if (root && !abs.startsWith(`${root}/`)) return null; // outside the app root
    return root ? abs.slice(root.length + 1) : abs.replace(/^\//, '');
  }

  fromProjectPath(projectPath) {
    return this.root === '/' ? `/${projectPath}` : `${this.root}/${projectPath}`.replace(/\/+/g, '/');
  }

  ensureDir(abs) {
    const parts = abs.split('/').filter(Boolean);
    let cursor = '';
    this.dirs.add('/');
    for (const part of parts) {
      cursor += `/${part}`;
      this.dirs.add(cursor);
    }
  }

  isDir(abs) {
    return this.dirs.has(abs);
  }

  isFile(abs) {
    return this.files.has(abs);
  }

  stat(abs) {
    const key = this.normalize(abs);
    const file = this.files.get(key);
    const dir = this.dirs.has(key);
    if (!file && !dir) return null;
    const now = Date.now();
    return {
      path: key,
      isFile: () => Boolean(file),
      isDirectory: () => Boolean(dir) && !file,
      isSymbolicLink: () => false,
      size: file ? file.data.byteLength : 4096,
      mtime: new Date(file?.mtime ?? now),
      atime: new Date(file?.mtime ?? now),
      ctime: new Date(file?.mtime ?? now),
      birthtime: new Date(file?.mtime ?? now),
      mode: file ? file.mode ?? 0o644 : 0o755,
      ino: hashPath(key),
      dev: 0,
      nlink: 1,
      uid: 0,
      gid: 0,
    };
  }

  /* --------------------------------------------------------------- io --- */

  hydrate(files) {
    for (const [path, content] of Object.entries(files || {})) {
      const abs = this.fromProjectPath(path);
      this.writeFile(abs, content, { silent: true });
    }
    this.dirs.add(this.root);
    this.ensureDir(this.root);
  }

  readFile(abs) {
    const key = this.normalize(abs);
    const file = this.files.get(key);
    if (!file) {
      const err = new Error(`ENOENT: no such file or directory, open '${key}'`);
      err.code = 'ENOENT';
      err.errno = -2;
      err.path = key;
      throw err;
    }
    this.ensureDir(key.slice(0, key.lastIndexOf('/')) || '/');
    return file.data;
  }

  writeFile(abs, data, { silent = false, mode } = {}) {
    const key = this.normalize(abs);
    if (this.dirs.has(key) && !this.files.has(key)) {
      const err = new Error(`EISDIR: illegal operation on a directory, open '${key}'`);
      err.code = 'EISDIR';
      throw err;
    }
    const parent = key.slice(0, key.lastIndexOf('/')) || '/';
    if (!this.dirs.has(parent)) {
      // Real Node would ENOENT here; npm tarballs write deep paths in any
      // order, so the runtime creates the parents instead of failing installs.
      this.ensureDir(parent);
    }
    const bytes = toBytes(data);
    this.files.set(key, { data: bytes, mtime: Date.now(), mode: mode ?? this.files.get(key)?.mode ?? 0o644 });
    if (!silent) this.dirty.add(key);
    this.removed.delete(key);
    return undefined;
  }

  unlink(abs) {
    const key = this.normalize(abs);
    if (!this.files.has(key)) {
      const err = new Error(`ENOENT: no such file or directory, unlink '${key}'`);
      err.code = 'ENOENT';
      throw err;
    }
    this.files.delete(key);
    this.dirty.delete(key);
    this.removed.add(key);
  }

  mkdir(abs, { recursive = false } = {}) {
    const key = this.normalize(abs);
    if (this.dirs.has(key) || this.files.has(key)) {
      if (recursive) return undefined;
      const err = new Error(`EEXIST: file already exists, mkdir '${key}'`);
      err.code = 'EEXIST';
      throw err;
    }
    const parent = key.slice(0, key.lastIndexOf('/')) || '/';
    if (!this.dirs.has(parent) && !recursive) {
      const err = new Error(`ENOENT: no such file or directory, mkdir '${key}'`);
      err.code = 'ENOENT';
      throw err;
    }
    this.ensureDir(key);
    return undefined;
  }

  readdir(abs, { withFileTypes = false } = {}) {
    const key = this.normalize(abs);
    if (!this.dirs.has(key)) {
      const err = new Error(`ENOTDIR: not a directory, scandir '${key}'`);
      err.code = 'ENOTDIR';
      throw err;
    }
    const prefix = key === '/' ? '/' : `${key}/`;
    const names = new Set();
    for (const p of this.files.keys()) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
    for (const d of this.dirs) if (d.startsWith(prefix) && d !== key) names.add(d.slice(prefix.length).split('/')[0]);
    const list = [...names].filter(Boolean).sort();
    if (!withFileTypes) return list;
    return list.map((name) => {
      const child = `${prefix}${name}`.replace(/\/+/g, '/');
      return {
        name,
        isFile: () => this.files.has(child),
        isDirectory: () => this.dirs.has(child),
        isSymbolicLink: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      };
    });
  }

  rmrf(abs) {
    const key = this.normalize(abs);
    const prefix = `${key}/`;
    for (const p of [...this.files.keys()]) {
      if (p === key || p.startsWith(prefix)) {
        this.files.delete(p);
        this.dirty.delete(p);
        this.removed.add(p);
      }
    }
    for (const d of [...this.dirs]) if (d === key || d.startsWith(prefix)) this.dirs.delete(d);
    if (key !== '/') this.dirs.add(key.slice(0, key.lastIndexOf('/')) || '/');
  }

  rename(from, to) {
    const a = this.normalize(from);
    const b = this.normalize(to);
    const file = this.files.get(a);
    if (!file) {
      const err = new Error(`ENOENT: no such file or directory, rename '${a}'`);
      err.code = 'ENOENT';
      throw err;
    }
    this.files.set(b, file);
    this.files.delete(a);
    this.removed.add(a);
    this.dirty.add(b);
    return undefined;
  }

  copyFile(from, to) {
    const source = this.files.get(this.normalize(from));
    if (!source) {
      const err = new Error(`ENOENT: no such file or directory, copyfile '${from}'`);
      err.code = 'ENOENT';
      throw err;
    }
    this.writeFile(to, source.data);
  }

  readlink() {
    const err = new Error('EINVAL: invalid argument, readlink (symlinks are not supported)');
    err.code = 'EINVAL';
    throw err;
  }

  symlink() {
    const err = new Error('ENOSYS: symlinks are not supported in the browser runtime');
    err.code = 'ENOSYS';
    throw err;
  }

  /** Files whose contents must be flushed back to the project store. */
  pendingWrites() {
    return [...this.dirty].filter((p) => this.files.has(p));
  }

  pendingDeletes() {
    return [...this.removed];
  }

  clearDirty() {
    this.dirty.clear();
    this.removed.clear();
  }

  walk(prefix = this.root) {
    const key = this.normalize(prefix);
    const out = [];
    for (const [p, file] of this.files) {
      if (p === key || p.startsWith(`${key}/`)) out.push({ path: p, size: file.data.byteLength });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function hashPath(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h;
}

const encoder = new TextEncoder();
export const toBytes = (data) => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data ?? ''));
};

export const decoder = new TextDecoder();

export const fromBytes = (bytes, encoding = 'utf8') => {
  const enc = String(encoding || 'utf8').toLowerCase();
  if (enc === 'utf8' || enc === 'utf-8') return decoder.decode(bytes);
  if (enc === 'hex') return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (enc === 'base64') return base64FromBytes(bytes);
  if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') return [...bytes].map((b) => String.fromCharCode(b)).join('');
  return decoder.decode(bytes);
};

export const base64FromBytes = (bytes) => {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
};

export const bytesFromBase64 = (text) => {
  const binary = atob(String(text).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};
