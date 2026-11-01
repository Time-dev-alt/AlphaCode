/**
 * Database editing.
 *
 *  • SQLite  — native (node:sqlite): schema browser, SQL console, row editing.
 *  • Postgres / MySQL — via psql / mysql clients when installed.
 *  • Turso (libSQL HTTP) and Neon/Supabase Data API — over HTTPS.
 *
 * Connection strings come from ALPHACODE_DATABASE_URLS or the user's encrypted
 * settings; credentials are never returned to the browser.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveReal, toRel, projectWorkspace } from './paths.mjs';
import { runCommand, which } from './exec.mjs';
import { bad, forbidden, notFound } from '../lib/http.mjs';
import { log } from '../lib/log.mjs';

const READ_RE = /^\s*(select|pragma|explain|with|show|describe|desc|table\s+information_schema)\b/i;
const WRITE_RE = /^\s*(insert|update|delete|create|drop|alter|replace|truncate|vacuum|reindex|grant|revoke)\b/i;

const openDbs = new Map();

export function isReadOnlySql(sql) {
  const s = String(sql).trim();
  if (READ_RE.test(s)) {
    // WITH ... DELETE would be a write; check for write keywords after CTE.
    if (/^\s*with\b/i.test(s) && /\b(insert|update|delete|drop|alter|create)\b/i.test(s)) return false;
    return true;
  }
  return false;
}
export function isWriteSql(sql) {
  return WRITE_RE.test(String(sql).trim());
}

export function dbFiles(projectId) {
  const root = projectWorkspace(projectId);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.venv') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(db|sqlite|sqlite3|db3)$/i.test(e.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        out.push({ path: path.relative(root, full).split(path.sep).join('/'), size });
      }
    }
  };
  walk(root, 0);
  return out.slice(0, 50);
}

export async function openSqlite(projectId, relPath) {
  const abs = await resolveReal(projectId, relPath || 'app.db');
  if (!/\.(db|sqlite|sqlite3|db3)$/i.test(abs) && !fs.existsSync(abs)) {
    // create brand new database files only with an explicit sqlite extension
    throw bad('Choose a .db / .sqlite file');
  }
  const key = abs;
  if (openDbs.has(key)) return openDbs.get(key);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const handle = { db, abs, rel: toRel(projectId, abs), projectId };
  openDbs.set(key, handle);
  return handle;
}

export function sqliteSchema(handle) {
  const { db } = handle;
  const objects = db
    .prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const tables = objects.map((o) => {
    let columns = [];
    try {
      columns = db.prepare(`PRAGMA table_info(${JSON.stringify(o.name)})`).all().map((c) => ({
        name: c.name,
        type: c.type,
        notNull: Boolean(c.notnull),
        pk: Boolean(c.pk),
        default: c.dflt_value,
      }));
    } catch {}
    let rows = 0;
    try {
      rows = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(o.name)}`).get().n;
    } catch {}
    return { name: o.name, type: o.type, sql: o.sql, columns, rows };
  });
  let version = '';
  try {
    version = db.prepare('SELECT sqlite_version() AS v').get().v;
  } catch {}
  return { tables, engine: 'sqlite', version, path: handle.rel };
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (/SQLITE|no such|syntax error|constraint|datatype/i.test(err.message)) {
      const e = bad(`SQL error: ${err.message}`);
      e.code = err.code || 'sql_error';
      throw e;
    }
    throw err;
  }
}

export function sqliteQuery(handle, sql, params = []) {
  return guard(() => sqliteQueryInner(handle, sql, params));
}

function sqliteQueryInner(handle, sql, params = []) {
  const { db } = handle;
  const started = Date.now();
  const statement = String(sql || '').trim();
  if (!statement) throw bad('Empty SQL statement');
  if (!isReadOnlySql(statement)) {
    return sqliteExec(handle, statement, params);
  }
  const prepared = db.prepare(statement);
  const rows = Array.isArray(params) && params.length ? prepared.all(...params) : prepared.all();
  const columns = prepared.columns?.()?.map((c) => c.name) || (rows[0] ? Object.keys(rows[0]) : []);
  return {
    type: 'rows',
    columns,
    rows: rows.slice(0, 500).map((r) => ({ ...r })),
    rowCount: rows.length,
    truncated: rows.length > 500,
    durationMs: Date.now() - started,
  };
}

export function sqliteExec(handle, sql, params = []) {
  return guard(() => sqliteExecInner(handle, sql, params));
}

function sqliteExecInner(handle, sql, params = []) {
  const { db } = handle;
  const started = Date.now();
  const statement = String(sql || '').trim();
  const results = [];
  let changes = 0;
  // node:sqlite executes one statement at a time; split naive but safe on ; outside quotes.
  for (const part of splitSql(statement)) {
    const prepared = db.prepare(part);
    const info = Array.isArray(params) && params.length ? prepared.run(...params) : prepared.run();
    changes += Number(info.changes || 0);
    results.push({ changes: Number(info.changes || 0), lastInsertRowid: Number(info.lastInsertRowid || 0) });
    params = [];
  }
  return { type: 'exec', results, changes, durationMs: Date.now() - started };
}

function splitSql(sql) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      cur += c;
      if (c === quote && sql[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      cur += sql.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function tableRows(handle, table, { limit = 100, offset = 0, orderBy = '', where = '' } = {}) {
  const { db } = handle;
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const allowedCols = new Set(
    (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() || []).map((c) => c.name),
  );
  let order = '';
  if (orderBy && allowedCols.has(orderBy)) order = ` ORDER BY ${quoteIdent(orderBy)}`;
  let clause = '';
  if (where && /^[\w\s"'=<>!().,%_+-]*$/.test(where)) clause = ` WHERE ${where}`;
  const rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${quoteIdent(table)}${clause}${order} LIMIT ? OFFSET ?`).all(safeLimit, safeOffset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${clause}`).get().n;
  const columns = rows[0] ? Object.keys(rows[0]) : [...allowedCols];
  return { columns, rows: rows.map((r) => ({ ...r })), total, limit: safeLimit, offset: safeOffset };
}

export function updateRow(handle, table, rowid, changes) {
  const { db } = handle;
  const cols = (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() || []).map((c) => c.name);
  const entries = Object.entries(changes || {}).filter(([k]) => cols.includes(k) && k !== '__rowid');
  if (!entries.length) throw bad('No editable columns supplied');
  const sql = `UPDATE ${quoteIdent(table)} SET ${entries.map(([k]) => `${quoteIdent(k)} = ?`).join(', ')} WHERE rowid = ?`;
  const info = db.prepare(sql).run(...entries.map(([, v]) => v), rowid);
  return { changes: Number(info.changes || 0) };
}

export function deleteRow(handle, table, rowid) {
  const info = handle.db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`).run(rowid);
  return { changes: Number(info.changes || 0) };
}

export function insertRow(handle, table, values) {
  const { db } = handle;
  const cols = (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() || []).map((c) => c.name);
  const entries = Object.entries(values || {}).filter(([k]) => cols.includes(k));
  if (!entries.length) throw bad('No columns supplied');
  const sql = `INSERT INTO ${quoteIdent(table)} (${entries.map(([k]) => quoteIdent(k)).join(',')}) VALUES (${entries.map(() => '?').join(',')})`;
  const info = db.prepare(sql).run(...entries.map(([, v]) => v));
  return { changes: Number(info.changes || 0), rowid: Number(info.lastInsertRowid || 0) };
}

// ------------------------------------------------------------- external DBs --
export function parseConnections(envValue, userConns = []) {
  const out = [];
  const push = (raw, source) => {
    if (!raw) return;
    try {
      const url = new URL(String(raw).trim());
      const engine = url.protocol.replace(':', '');
      if (!['postgres', 'postgresql', 'mysql', 'mysql2', 'sqlite', 'libsql', 'https'].includes(engine)) return;
      out.push({
        id: `${source}:${url.hostname}${url.pathname}`,
        engine: engine.replace('2', ''),
        host: url.hostname,
        database: url.pathname.replace(/^\//, '') || '',
        user: url.username,
        url: url.toString(),
        source,
        name: `${engine.replace('2', '')}://${url.hostname}/${url.pathname.replace(/^\//, '')}`,
      });
    } catch {}
  };
  for (const part of String(envValue || '').split(/[,\n]/)) push(part.trim(), 'env');
  for (const c of userConns) push(c.url, 'user');
  return out;
}

export async function externalQuery(conn, sql, { readOnly = false } = {}) {
  if (readOnly && !isReadOnlySql(sql)) throw forbidden('This connection is read-only');
  const engine = conn.engine;
  if (engine === 'postgres') {
    if (!(await which('psql'))) throw bad('psql is not installed on this instance — use a Data API connection or SQLite');
    const res = await runCommand(`psql ${JSON.stringify(conn.url)} -v ON_ERROR_STOP=1 -A -F $'\\t' -c ${JSON.stringify(sql)}`, { timeoutMs: 60000 });
    return cliResult(res);
  }
  if (engine === 'mysql') {
    if (!(await which('mysql'))) throw bad('mysql client is not installed on this instance');
    const host = conn.host;
    const user = conn.user;
    const db = conn.database;
    const res = await runCommand(`mysql -h ${JSON.stringify(host)} -u ${JSON.stringify(user)} ${db ? JSON.stringify(db) : ''} -e ${JSON.stringify(sql)}`, {
      timeoutMs: 60000,
      env: { MYSQL_PWD: process.env.MYSQL_PWD || '' },
    });
    return cliResult(res);
  }
  if (engine === 'libsql' || engine === 'https') {
    // Turso / libSQL HTTP pipeline API
    const res = await fetch(conn.url.replace(/^libsql:/, 'https:').replace(/\/$/, '') + '/v2/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN || ''}` },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw bad(`Database returned HTTP ${res.status}`);
    return { type: 'rows', raw: await res.json() };
  }
  throw bad(`Unsupported engine: ${engine}`);
}

function cliResult(res) {
  if (res.code !== 0) throw bad(`SQL error: ${res.output.slice(0, 800)}`);
  const lines = res.output.trim().split('\n').filter(Boolean);
  const columns = (lines.shift() || '').split('\t');
  const rows = lines.map((l) => {
    const cells = l.split('\t');
    const row = {};
    columns.forEach((c, i) => (row[c] = cells[i]));
    return row;
  });
  return { type: 'rows', columns, rows: rows.slice(0, 500), rowCount: rows.length };
}

export function closeAll() {
  for (const [, h] of openDbs) {
    try {
      h.db.close();
    } catch {}
  }
  openDbs.clear();
}

export function engineSummary(detected) {
  return [
    { engine: 'sqlite', label: 'SQLite (native)', available: true },
    { engine: 'postgres', label: 'PostgreSQL (psql)', available: Boolean(detected?.tools?.psql) },
    { engine: 'mysql', label: 'MySQL (mysql)', available: Boolean(detected?.tools?.mysql) },
    { engine: 'libsql', label: 'Turso / libSQL (HTTP)', available: true },
  ];
}
