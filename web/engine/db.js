/**
 * Database editing in the browser.
 *
 * SQLite runs as WebAssembly (sql.js) inside the page, so the agent can create
 * schemas, run SQL, edit rows and inspect indexes with no server and no native
 * module. Database files are ordinary project files (`.sqlite`), so they sync
 * with the workspace, export with the project and ship with a deploy.
 */

let enginePromise = null;

/** Load sql.js once. Accepts an injected module for tests. */
export async function loadEngine(loader) {
  if (loader) return loader();
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    // Bundled with the app: in the browser the .wasm ships next to the bundle,
    // so locateFile resolves to /assets/sql-wasm.wasm (no CDN, no server).
    const mod = await import('sql.js');
    const init = mod.default || mod;
    // In the Pages build, __ASSET_BASE__ is injected ("/assets/") and the wasm sits
    // next to the bundle. In Node (tests) the constant is undefined, so sql.js
    // locates its own copy. Detect, do not retry: a bad locateFile aborts the
    // Emscripten module and that abort cannot be caught.
    if (typeof __ASSET_BASE__ !== 'undefined') {
      return init({ locateFile: (file) => new URL(file, location.origin + __ASSET_BASE__).href });
    }
    return init();
  })();
  return enginePromise;
}

export function setEngine(db) {
  enginePromise = Promise.resolve(db);
}

/** Split a SQL script into statements, respecting strings, comments and triggers. */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let blockDepth = 0; // BEGIN…END bodies (triggers) contain their own semicolons
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const n = sql[i + 1];
    if (lineComment) {
      cur += c;
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      cur += c;
      if (c === '*' && n === '/') {
        cur += n;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) {
        if (quote === "'" && n === "'") {
          cur += n;
          i++;
        } else quote = null;
      }
      continue;
    }
    if (c === '-' && n === '-') {
      cur += c + n;
      i++;
      lineComment = true;
      continue;
    }
    if (c === '/' && n === '*') {
      cur += c + n;
      i++;
      blockComment = true;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (blockDepth === 0 && /[A-Za-z_]/.test(c) && (c === 'B' || c === 'E' || c === 'b' || c === 'e')) {
      const rest = sql.slice(i);
      const begin = /^BEGIN\b/i.exec(rest);
      const end = /^END\b/i.exec(rest);
      if (begin && /\bCREATE\s+(TEMP\s+)?TRIGGER\b/i.test(cur)) {
        blockDepth++;
        cur += begin[0];
        i += begin[0].length - 1;
        continue;
      }
      if (end && blockDepth > 0) {
        blockDepth--;
        cur += end[0];
        i += end[0].length - 1;
        continue;
      }
    }
    if (c === ';' && blockDepth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const isReadOnlySql = (sql) => /^\s*(select|pragma|with|explain)\b/i.test(String(sql));

/** sql.js result rows → array of objects. */
export function rowsToObjects(result) {
  if (!result?.length) return { columns: [], rows: [] };
  const first = result[0];
  const columns = first.columns || [];
  const rows = first.values.map((values) => Object.fromEntries(columns.map((c, i) => [c, values[i]])));
  return { columns, rows };
}

export class ProjectDatabase {
  constructor({ SQL, name = 'db.sqlite', data } = {}) {
    this.SQL = SQL;
    this.name = name;
    this.db = data ? new SQL.Database(data) : new SQL.Database();
  }

  schema() {
    const tables = rowsToObjects(this.db.exec("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"));
    return tables.rows.map((t) => {
      const cols = rowsToObjects(this.db.exec(`PRAGMA table_info(${JSON.stringify(t.name)})`)).rows;
      const indexes = rowsToObjects(this.db.exec(`PRAGMA index_list(${JSON.stringify(t.name)})`)).rows;
      const count = rowsToObjects(this.db.exec(`SELECT COUNT(*) AS n FROM ${JSON.stringify(t.name)}`)).rows[0]?.n ?? 0;
      return {
        name: t.name,
        type: t.type,
        sql: t.sql,
        count,
        columns: cols.map((c) => ({ name: c.name, type: c.type, notNull: Boolean(c.notnull), pk: Boolean(c.pk), default: c.dflt_value })),
        indexes: indexes.map((i) => ({ name: i.name, unique: Boolean(i.unique) })),
      };
    });
  }

  query(sql, params = []) {
    if (!isReadOnlySql(sql)) throw new Error('query() only accepts read-only SQL — use exec() for writes');
    const stmt = this.db.prepare(sql);
    try {
      if (params.length) stmt.bind(params);
      const rows = [];
      const columns = stmt.getColumnNames();
      while (stmt.step()) rows.push(stmt.getAsObject());
      return { type: 'rows', columns, rows: rows.slice(0, 1000), truncated: rows.length > 1000 };
    } finally {
      stmt.free?.();
    }
  }

  exec(sql, params = []) {
    const statements = splitStatements(sql);
    if (!statements.length) throw new Error('No SQL to run');
    if (statements.length === 1 && isReadOnlySql(statements[0])) return this.query(statements[0], params);
    const results = [];
    for (const statement of statements) {
      const stmt = this.db.prepare(statement);
      try {
        if (params.length && statements.length === 1) stmt.bind(params);
        stmt.step();
      } finally {
        stmt.free?.();
      }
      results.push({ statement: statement.slice(0, 120) });
    }
    const changes = this.db.getRowsModified();
    return { type: 'write', statements: results, changes };
  }

  tableRows(table, { limit = 100, offset = 0, orderBy = '', where = '' } = {}) {
    const safeTable = String(table).replace(/"/g, '""');
    const clause = where ? ` WHERE ${where}` : '';
    const order = orderBy ? ` ORDER BY ${orderBy}` : '';
    return this.query(
      `SELECT rowid AS __rowid, * FROM "${safeTable}"${clause}${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    );
  }

  updateRow(table, rowid, changes) {
    const keys = Object.keys(changes || {});
    if (!keys.length) throw new Error('No changes');
    const safeTable = String(table).replace(/"/g, '""');
    const set = keys.map((k) => `"${k.replace(/"/g, '""')}" = ?`).join(', ');
    return this.exec(`UPDATE "${safeTable}" SET ${set} WHERE rowid = ?`, [...keys.map((k) => changes[k]), Number(rowid)]);
  }

  insertRow(table, values) {
    const keys = Object.keys(values || {});
    if (!keys.length) throw new Error('No values');
    const safeTable = String(table).replace(/"/g, '""');
    return this.exec(
      `INSERT INTO "${safeTable}" (${keys.map((k) => `"${k.replace(/"/g, '""')}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((k) => values[k]),
    );
  }

  deleteRow(table, rowid) {
    const safeTable = String(table).replace(/"/g, '""');
    return this.exec(`DELETE FROM "${safeTable}" WHERE rowid = ?`, [Number(rowid)]);
  }

  export() {
    return this.db.export();
  }
}

/** Open (or create) a database file stored in the project filesystem. */
export async function openDatabase(fs, projectId, path, { loader } = {}) {
  const SQL = await loadEngine(loader);
  let data;
  try {
    const raw = await fs.read(projectId, path);
    data = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
    if (!data.length) data = undefined;
  } catch {
    data = undefined;
  }
  return new ProjectDatabase({ SQL, name: path, data });
}

export async function saveDatabase(fs, projectId, db) {
  const bytes = db.export();
  await fs.write(projectId, db.name, bytes);
  return bytes.byteLength;
}

/** List *.sqlite / *.db files in a project. */
export async function dbFiles(fs, projectId) {
  const files = await fs.list(projectId);
  return files.filter((f) => /\.(sqlite3?|db)$/i.test(f.path)).map((f) => ({ path: f.path, size: f.size }));
}
