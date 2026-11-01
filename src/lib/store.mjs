/**
 * Persistence layer (SQLite via node:sqlite — zero external dependencies).
 *
 * Tables are created on boot; migrations are additive and idempotent.
 */
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.mjs';
import { log } from './log.mjs';
import { randomId } from './crypto.mjs';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  guest      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id       TEXT PRIMARY KEY,
  byok          TEXT NOT NULL DEFAULT '',
  deploy_tokens TEXT NOT NULL DEFAULT '',
  prefs         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id    TEXT,
  title      TEXT NOT NULL DEFAULT 'New session',
  model      TEXT NOT NULL DEFAULT '',
  mode       TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);

CREATE TABLE IF NOT EXISTS quota (
  key   TEXT NOT NULL,
  day   TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);

CREATE TABLE IF NOT EXISTS deployments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT,
  user_id       TEXT,
  provider      TEXT NOT NULL,
  url           TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'building',
  claim_token   TEXT UNIQUE,
  claim_expires INTEGER NOT NULL DEFAULT 0,
  claimed_by    TEXT,
  claimed_at    INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deploy_project ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deploy_claim ON deployments(claim_token);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit(user_id, created_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id);
`;

export class Store {
  constructor(file = path.join(config.dataDir, 'alphacode.db')) {
    if (!DatabaseSync) {
      throw new Error(
        'AlphaCode needs Node.js 22.13+ (node:sqlite). Upgrade Node: https://nodejs.org/en/download (or `nvm install 24`).',
      );
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.stmtCache = new Map();
    log.info(`store ready (${path.relative(config.root, file)})`);
  }

  p(sql) {
    let st = this.stmtCache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmtCache.set(sql, st);
    }
    return st;
  }

  run(sql, ...params) {
    return this.p(sql).run(...params);
  }
  get(sql, ...params) {
    const row = this.p(sql).get(...params);
    return row ? { ...row } : null;
  }
  all(sql, ...params) {
    return this.p(sql).all(...params).map((r) => ({ ...r }));
  }
  exec(sql) {
    return this.db.exec(sql);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  // ---- users -----------------------------------------------------------
  createUser({ email, passwordHash, name = '' }) {
    const id = randomId('u_');
    const now = Date.now();
    this.run('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)', id, email.toLowerCase(), passwordHash, name, now);
    this.run('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)', id);
    return this.getUser(id);
  }
  getUser(id) {
    return this.get('SELECT * FROM users WHERE id = ?', id);
  }
  getUserByEmail(email) {
    return this.get('SELECT * FROM users WHERE email = ?', String(email).toLowerCase());
  }
  countUsers() {
    return this.get('SELECT COUNT(*) AS n FROM users')?.n || 0;
  }

  // ---- sessions --------------------------------------------------------
  createSession({ userId = null, guest = true, days = config.security.sessionDays, ip = '', ua = '' }) {
    const id = randomId('s_', 24);
    const now = Date.now();
    this.run(
      'INSERT INTO sessions (id,user_id,guest,created_at,expires_at,ip,ua) VALUES (?,?,?,?,?,?,?)',
      id,
      userId,
      guest ? 1 : 0,
      now,
      now + days * 86400000,
      ip.slice(0, 64),
      ua.slice(0, 240),
    );
    return { id, userId, guest, expiresAt: now + days * 86400000 };
  }
  getSession(id) {
    if (!id) return null;
    const row = this.get('SELECT * FROM sessions WHERE id = ?', id);
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.run('DELETE FROM sessions WHERE id = ?', id);
      return null;
    }
    return row;
  }
  destroySession(id) {
    this.run('DELETE FROM sessions WHERE id = ?', id);
  }
  upgradeSession(id, userId) {
    this.run('UPDATE sessions SET user_id = ?, guest = 0 WHERE id = ?', userId, id);
  }
  purgeExpired() {
    this.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  }

  // ---- settings --------------------------------------------------------
  settings(userId) {
    if (!userId) return { user_id: null, byok: '', deploy_tokens: '', prefs: '{}' };
    let row = this.get('SELECT * FROM user_settings WHERE user_id = ?', userId);
    if (!row) {
      this.run('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)', userId);
      row = this.get('SELECT * FROM user_settings WHERE user_id = ?', userId);
    }
    return row;
  }
  saveSettings(userId, patch) {
    const cur = this.settings(userId);
    const next = {
      byok: patch.byok ?? cur.byok,
      deploy_tokens: patch.deploy_tokens ?? cur.deploy_tokens,
      prefs: patch.prefs ?? cur.prefs,
    };
    this.run('UPDATE user_settings SET byok = ?, deploy_tokens = ?, prefs = ? WHERE user_id = ?', next.byok, next.deploy_tokens, next.prefs, userId);
  }

  // ---- projects / threads / messages ----------------------------------
  createProject({ userId = null, name = 'Untitled project', slug }) {
    const id = randomId('p_', 10);
    const now = Date.now();
    const s = slug || id;
    this.run('INSERT INTO projects (id,user_id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, userId, name, s, now, now);
    return this.getProject(id);
  }
  getProject(id) {
    return this.get('SELECT * FROM projects WHERE id = ?', id);
  }
  listProjects(userId) {
    if (userId) return this.all('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100', userId);
    return [];
  }
  listProjectsByOwnerKey(ownerKey) {
    return this.all('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100', ownerKey);
  }
  touchProject(id) {
    this.run('UPDATE projects SET updated_at = ? WHERE id = ?', Date.now(), id);
  }
  deleteProject(id) {
    this.run('DELETE FROM threads WHERE project_id = ?', id);
    this.run('DELETE FROM projects WHERE id = ?', id);
  }
  createThread({ projectId, userId = null, title = 'New session', model = '', mode = 'default' }) {
    const id = randomId('t_', 10);
    const now = Date.now();
    this.run(
      'INSERT INTO threads (id,project_id,user_id,title,model,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      projectId,
      userId,
      title,
      model,
      mode,
      now,
      now,
    );
    return this.getThread(id);
  }
  getThread(id) {
    return this.get('SELECT * FROM threads WHERE id = ?', id);
  }
  listThreads(projectId) {
    return this.all('SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC', projectId);
  }
  updateThread(id, patch) {
    const cur = this.getThread(id);
    if (!cur) return null;
    this.run(
      'UPDATE threads SET title = ?, model = ?, mode = ?, updated_at = ? WHERE id = ?',
      patch.title ?? cur.title,
      patch.model ?? cur.model,
      patch.mode ?? cur.mode,
      Date.now(),
      id,
    );
    return this.getThread(id);
  }
  addMessage({ threadId, role, content, meta = {}, seq }) {
    const id = randomId('m_', 8);
    const nextSeq = seq ?? (this.get('SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE thread_id = ?', threadId)?.n || 1);
    this.run('INSERT INTO messages (id,thread_id,seq,role,content,meta,created_at) VALUES (?,?,?,?,?,?,?)', id, threadId, nextSeq, role, JSON.stringify(content), JSON.stringify(meta), Date.now());
    return { id, seq: nextSeq };
  }
  listMessages(threadId, limit = 400) {
    return this.all('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq ASC LIMIT ?', threadId, limit).map((m) => ({
      ...m,
      content: safeParse(m.content, null),
      meta: safeParse(m.meta, {}),
    }));
  }
  clearMessages(threadId) {
    this.run('DELETE FROM messages WHERE thread_id = ?', threadId);
  }
  nextSeq(threadId) {
    return this.get('SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE thread_id = ?', threadId)?.n || 1;
  }

  // ---- quota -----------------------------------------------------------
  bumpQuota(key, { turns = 0, calls = 0, tokens = 0, day = today() }) {
    this.run(
      `INSERT INTO quota (key, day, turns, calls, tokens) VALUES (?,?,?,?,?)
       ON CONFLICT(key, day) DO UPDATE SET turns = turns + excluded.turns, calls = calls + excluded.calls, tokens = tokens + excluded.tokens`,
      key,
      day,
      turns,
      calls,
      tokens,
    );
    return this.getQuota(key, day);
  }
  getQuota(key, day = today()) {
    const row = this.get('SELECT * FROM quota WHERE key = ? AND day = ?', key, day);
    return { turns: row?.turns || 0, calls: row?.calls || 0, tokens: row?.tokens || 0 };
  }

  // ---- deployments -----------------------------------------------------
  createDeployment({ projectId, userId, provider, status = 'building', meta = {}, claimToken = null, claimExpires = 0, url = '' }) {
    const id = randomId('d_', 10);
    this.run(
      'INSERT INTO deployments (id,project_id,user_id,provider,url,status,claim_token,claim_expires,meta,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      projectId,
      userId,
      provider,
      url,
      status,
      claimToken,
      claimExpires,
      JSON.stringify(meta),
      Date.now(),
    );
    return this.getDeployment(id);
  }
  getDeployment(id) {
    const row = this.get('SELECT * FROM deployments WHERE id = ?', id);
    return row ? { ...row, meta: safeParse(row.meta, {}) } : null;
  }
  getDeploymentByClaim(token) {
    const row = this.get('SELECT * FROM deployments WHERE claim_token = ?', token);
    return row ? { ...row, meta: safeParse(row.meta, {}) } : null;
  }
  updateDeployment(id, patch) {
    const cur = this.get('SELECT * FROM deployments WHERE id = ?', id);
    if (!cur) return null;
    this.run(
      'UPDATE deployments SET url = ?, status = ?, claimed_by = ?, claimed_at = ?, meta = ?, claim_token = ?, claim_expires = ? WHERE id = ?',
      patch.url ?? cur.url,
      patch.status ?? cur.status,
      patch.claimedBy ?? cur.claimed_by,
      patch.claimedAt ?? cur.claimed_at,
      JSON.stringify(patch.meta ?? safeParse(cur.meta, {})),
      patch.claimToken === undefined ? cur.claim_token : patch.claimToken,
      patch.claimExpires ?? cur.claim_expires,
      id,
    );
    return this.getDeployment(id);
  }
  listDeployments(projectId) {
    return this.all('SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 40', projectId).map((r) => ({
      ...r,
      meta: safeParse(r.meta, {}),
    }));
  }
  listDeploymentsForUser(userId) {
    return this.all(
      'SELECT * FROM deployments WHERE user_id = ? OR claimed_by = ? ORDER BY created_at DESC LIMIT 60',
      userId,
      userId,
    ).map((r) => ({ ...r, meta: safeParse(r.meta, {}) }));
  }
  pendingClaims() {
    return this.all(
      "SELECT * FROM deployments WHERE claimed_by IS NULL AND claim_token IS NOT NULL AND claim_expires > ? AND provider = 'local' ORDER BY created_at DESC LIMIT 50",
      Date.now(),
    ).map((r) => ({ ...r, meta: safeParse(r.meta, {}) }));
  }

  // ---- audit -----------------------------------------------------------
  audit({ userId = null, action, detail = '', ip = '' }) {
    try {
      this.run(
        'INSERT INTO audit (user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?)',
        userId,
        String(action).slice(0, 80),
        typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500),
        ip.slice(0, 64),
        Date.now(),
      );
    } catch (err) {
      log.debug('audit failed', err.message);
    }
  }
  listAudit(userId, limit = 100) {
    return this.all('SELECT * FROM audit WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit);
  }

  // ---- checkpoints -----------------------------------------------------
  addCheckpoint({ projectId, label, ref }) {
    const id = randomId('c_', 8);
    this.run('INSERT INTO checkpoints (id,project_id,label,ref,created_at) VALUES (?,?,?,?,?)', id, projectId, label, ref, Date.now());
    return id;
  }
  listCheckpoints(projectId, limit = 50) {
    return this.all('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit);
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

export function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function safeParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

let store = null;
export function getStore() {
  if (!store) store = new Store();
  return store;
}
export function setStore(s) {
  store = s;
}
