/**
 * Browser persistence: IndexedDB for entities, with an in-memory backend so the
 * same code runs (and is tested) under Node.
 *
 * Everything a user does lives in *their* browser. Nothing here is sent to us:
 * there is no server. Clearing site data deletes the workspace, which is the
 * honest trade-off of a zero-backend product.
 */

const DB_NAME = 'alphacode';
const DB_VERSION = 1;
const STORES = ['users', 'sessions', 'projects', 'threads', 'messages', 'settings', 'deployments', 'kv', 'snapshots'];

/** structuredClone with a JSON fallback (older browsers, some test DOMs). */
const clone = (value) =>
  typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value ?? null));

export class MemoryBackend {
  constructor() {
    this.tables = new Map(STORES.map((s) => [s, new Map()]));
    this.kv = new Map();
  }
  async open() {}
  async put(store, id, value) {
    this.tables.get(store).set(id, clone(value));
  }
  async get(store, id) {
    const v = this.tables.get(store).get(id);
    return v ? clone(v) : null;
  }
  async all(store) {
    return [...this.tables.get(store).values()].map((v) => clone(v));
  }
  async del(store, id) {
    this.tables.get(store).delete(id);
  }
  async clear(store) {
    this.tables.get(store).clear();
  }
  async getKV(key) {
    return this.kv.has(key) ? clone(this.kv.get(key)) : null;
  }
  async setKV(key, value) {
    this.kv.set(key, clone(value));
  }
}

export class IdbBackend {
  constructor(name = DB_NAME) {
    this.name = name;
    this.db = null;
  }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    });
  }
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      let result;
      try {
        result = fn(os);
      } catch (err) {
        reject(err);
        return;
      }
      t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }
  put(store, id, value) {
    return this.tx(store, 'readwrite', (os) => os.put({ ...value, id }));
  }
  get(store, id) {
    return this.tx(store, 'readonly', (os) => ({ __req: os.get(id) })).then((v) => v ?? null);
  }
  all(store) {
    return this.tx(store, 'readonly', (os) => ({ __req: os.getAll() })).then((v) => v || []);
  }
  del(store, id) {
    return this.tx(store, 'readwrite', (os) => os.delete(id));
  }
  clear(store) {
    return this.tx(store, 'readwrite', (os) => os.clear());
  }
  async getKV(key) {
    const row = await this.get('kv', key);
    return row ? row.value : null;
  }
  async setKV(key, value) {
    await this.put('kv', key, { value });
  }
}

export const uid = (prefix = '', bytes = 8) => {
  const buf = new Uint8Array(bytes);
  (globalThis.crypto || {}).getRandomValues
    ? globalThis.crypto.getRandomValues(buf)
    : buf.forEach((_, i) => (buf[i] = Math.floor(Math.random() * 256)));
  return prefix + [...buf].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, bytes * 2);
};

export class Store {
  constructor(backend) {
    this.backend = backend;
    this.cache = { projects: null };
  }

  // ---- users ---------------------------------------------------------------
  async userByEmail(email) {
    const needle = String(email || '').trim().toLowerCase();
    if (!needle) return null;
    const users = await this.backend.all('users');
    return users.find((u) => u.email === needle) || null;
  }
  async user(id) {
    return id ? this.backend.get('users', id) : null;
  }
  async createUser({ email, passwordHash, salt }) {
    const user = { id: uid('u_'), email: String(email).trim().toLowerCase(), passwordHash, salt, createdAt: Date.now() };
    await this.backend.put('users', user.id, user);
    return user;
  }

  // ---- projects ------------------------------------------------------------
  async projects() {
    const list = await this.backend.all('projects');
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async project(id) {
    return id ? this.backend.get('projects', id) : null;
  }
  async createProject({ name }) {
    const now = Date.now();
    const project = { id: uid('p_', 6), name: name || 'Untitled', createdAt: now, updatedAt: now, archived: false };
    await this.backend.put('projects', project.id, project);
    const thread = await this.createThread(project.id, 'New session');
    return { project, thread };
  }
  async touchProject(id) {
    const p = await this.project(id);
    if (!p) return;
    p.updatedAt = Date.now();
    await this.backend.put('projects', p.id, p);
  }
  async updateProject(id, patch) {
    const p = await this.project(id);
    if (!p) throw new Error('Project not found');
    Object.assign(p, patch, { updatedAt: Date.now() });
    await this.backend.put('projects', p.id, p);
    return p;
  }
  async deleteProject(id) {
    for (const t of await this.threads(id)) {
      for (const m of await this.messages(t.id)) await this.backend.del('messages', m.id);
      await this.backend.del('threads', t.id);
    }
    await this.backend.del('projects', id);
  }

  // ---- threads & messages --------------------------------------------------
  async threads(projectId) {
    const list = (await this.backend.all('threads')).filter((t) => t.projectId === projectId);
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async thread(id) {
    return id ? this.backend.get('threads', id) : null;
  }
  async createThread(projectId, title = 'New session') {
    const now = Date.now();
    const thread = { id: uid('t_', 6), projectId, title, createdAt: now, updatedAt: now };
    await this.backend.put('threads', thread.id, thread);
    return thread;
  }
  async updateThread(id, patch) {
    const t = await this.thread(id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: Date.now() });
    await this.backend.put('threads', t.id, t);
    return t;
  }
  async clearThread(id) {
    for (const m of await this.messages(id)) await this.backend.del('messages', m.id);
  }
  async messages(threadId) {
    const list = (await this.backend.all('messages')).filter((m) => m.threadId === threadId);
    return list.sort((a, b) => a.seq - b.seq);
  }
  async addMessage(threadId, role, content, meta = {}) {
    const existing = await this.messages(threadId);
    const msg = { id: uid('m_'), threadId, role, content, meta, seq: (existing.at(-1)?.seq || 0) + 1, createdAt: Date.now() };
    await this.backend.put('messages', msg.id, msg);
    return msg;
  }

  // ---- settings ------------------------------------------------------------
  async settings() {
    return (await this.backend.getKV('settings')) || {};
  }
  async saveSettings(patch) {
    const next = { ...(await this.settings()), ...patch };
    await this.backend.setKV('settings', next);
    return next;
  }

  // ---- deployments ---------------------------------------------------------
  async deployments(projectId) {
    const list = (await this.backend.all('deployments')).filter((d) => !projectId || d.projectId === projectId);
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }
  async addDeployment(d) {
    const row = { id: uid('d_', 6), createdAt: Date.now(), ...d };
    await this.backend.put('deployments', row.id, row);
    return row;
  }

  // ---- snapshots (undo) ----------------------------------------------------
  async snapshot(projectId, files, label = 'checkpoint') {
    const snap = { id: uid('s_', 6), projectId, label, createdAt: Date.now(), files };
    await this.backend.put('snapshots', snap.id, snap);
    const all = (await this.backend.all('snapshots')).filter((s) => s.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
    for (const old of all.slice(40)) await this.backend.del('snapshots', old.id);
    return snap;
  }
  async snapshots(projectId) {
    return (await this.backend.all('snapshots')).filter((s) => s.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
  }
  async snapshotById(id) {
    return this.backend.get('snapshots', id);
  }
}

/** Pick the best backend available in this environment. */
export async function createStore({ backend } = {}) {
  if (backend) return new Store(backend);
  if (typeof indexedDB !== 'undefined') {
    const idb = new IdbBackend();
    try {
      await idb.open();
      return new Store(idb);
    } catch {
      /* fall through to memory */
    }
  }
  return new Store(new MemoryBackend());
}
