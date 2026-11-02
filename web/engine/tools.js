/**
 * The agent's tools — all executed in the browser.
 *
 * Same names and argument shapes as the server version, so a model that learned
 * Claude Code-style tooling behaves identically here. Every tool receives the
 * harness context and returns `{ text, display?, isError?, truncated? }`.
 */
import { openDatabase, saveDatabase, dbFiles, isReadOnlySql } from './db.js';
import { isBinaryPath, normPath } from './fs.js';
import { renderScaffold, SCAFFOLDS, SCAFFOLD_IDS } from './agent/scaffolds.js';

const MAX_TOOL_OUTPUT = 24_000;
const truncate = (text, limit = MAX_TOOL_OUTPUT) =>
  text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters]` : text;

function ok(text, display) {
  return { text: truncate(String(text)), display };
}
function err(text) {
  return { text: `Error: ${text}`, isError: true };
}

/** unified diff between two strings (small, good enough for display + edits). */
export function unifiedDiff(oldText = '', newText = '', file = 'file', context = 3) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', line: a[i] });
      i++;
      j++;
      continue;
    }
    const lookahead = 6;
    let found = -1;
    for (let k = 1; k <= lookahead && found < 0; k++) {
      if (a[i + k] === b[j]) found = k;
    }
    let foundAdd = -1;
    for (let k = 1; k <= lookahead && foundAdd < 0; k++) {
      if (b[j + k] === a[i]) foundAdd = k;
    }
    if (found >= 0 && (foundAdd < 0 || found <= foundAdd)) {
      for (let k = 0; k < found; k++) ops.push({ type: '-', line: a[i++] });
    } else if (foundAdd >= 0) {
      for (let k = 0; k < foundAdd; k++) ops.push({ type: '+', line: b[j++] });
    } else {
      if (i < a.length) ops.push({ type: '-', line: a[i++] });
      if (j < b.length) ops.push({ type: '+', line: b[j++] });
    }
  }
  if (!ops.some((o) => o.type !== ' ')) return '';
  const lines = [`--- a/${file}`, `+++ b/${file}`];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  while (cursor < ops.length) {
    if (ops[cursor].type === ' ') {
      oldLine++;
      newLine++;
      cursor++;
      continue;
    }
    const start = Math.max(0, cursor - context);
    let end = cursor;
    while (end < ops.length && (ops[end].type !== ' ' || ops.slice(end, end + context * 2).some((o) => o.type !== ' '))) end++;
    end = Math.min(ops.length, end + context);
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((o) => o.type !== '+').length;
    const newCount = slice.filter((o) => o.type !== '-').length;
    lines.push(`@@ -${start === 0 ? 1 : oldLine - (cursor - start)} ,${oldCount} +${newStart(cursor, start, newLine)} ,${newCount} @@`.replace(' ,', ','));
    for (const op of slice) lines.push(`${op.type}${op.line}`);
    for (let k = cursor; k < end; k++) {
      if (ops[k].type !== '+') oldLine++;
      if (ops[k].type !== '-') newLine++;
    }
    cursor = end;
  }
  return lines.join('\n');
}
const newStart = (cursor, start, newLine) => Math.max(1, newLine - (cursor - start));

export function buildTools(ctx) {
  const { fs, store, projectId, shell, getDb, releaseDb, emit, signal, confirm } = ctx;

  const saveDb = async (path, db) => {
    await saveDatabase(fs, projectId, db);
    return path;
  };

  const tools = [
    {
      name: 'read',
      description: 'Read a text file from the project. Use offsets for large files. Returns line-numbered content.',
      schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
        required: ['file_path'],
      },
      readOnly: true,
      async run({ file_path, offset = 1, limit = 2000 }) {
        const path = normPath(file_path);
        if (!(await fs.exists(projectId, path))) return err(`File not found: ${path}`);
        if (isBinaryPath(path)) return err(`${path} is a binary file`);
        const text = await fs.readText(projectId, path);
        const lines = text.split('\n');
        const from = Math.max(0, Number(offset) - 1);
        const slice = lines.slice(from, from + Number(limit));
        return ok(slice.map((line, i) => `${String(from + i + 1).padStart(5)}→${line}`).join('\n'), {
          kind: 'read',
          path,
          lines: slice.length,
          total: lines.length,
        });
      },
    },
    {
      name: 'read_many',
      description:
        'Read several files in ONE call. Prefer this over repeated single reads: it is one request instead of five.',
      schema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'File paths, in the order you want them back.' },
          limit: { type: 'number', description: 'Lines per file (default 1200).' },
        },
        required: ['paths'],
      },
      readOnly: true,
      async run({ paths = [], limit = 1200 }) {
        const files = paths.slice(0, 20);
        const parts = [];
        let bytes = 0;
        for (const raw of files) {
          const path = normPath(raw);
          if (isBinaryPath(path)) {
            parts.push(`### ${path}\n[binary file skipped]`);
            continue;
          }
          if (!(await fs.exists(projectId, path))) {
            parts.push(`### ${path}\n[not found — it does not exist yet]`);
            continue;
          }
          const text = await fs.readText(projectId, path).catch(() => '');
          const lines = text.split('\n');
          bytes += text.length;
          // A shared budget keeps one huge file from crowding out the others.
          const room = Math.max(80, Math.floor(4000 / Math.max(1, files.length)));
          const shown = lines.slice(0, Math.min(Number(limit), room));
          const more = lines.length > shown.length ? `\n… [${lines.length - shown.length} more lines]` : '';
          parts.push(`### ${path} (${lines.length} lines)\n${shown.map((line, i) => `${String(i + 1).padStart(5)}→${line}`).join('\n')}${more}`);
        }
        return ok(parts.join('\n\n'), { kind: 'read-many', count: files.length, bytes });
      },
    },
    {
      name: 'write_many',
      description:
        'Create or overwrite several files in ONE call. Use this whenever a task touches more than one file — it is one request instead of one per file.',
      schema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { file_path: { type: 'string' }, content: { type: 'string' } },
              required: ['file_path', 'content'],
            },
          },
        },
        required: ['files'],
      },
      mutating: true,
      async run({ files = [] }) {
        const written = [];
        for (const entry of files.slice(0, 40)) {
          if (!entry?.file_path) continue;
          const path = normPath(entry.file_path);
          const existed = await fs.exists(projectId, path);
          const before = existed ? await fs.readText(projectId, path).catch(() => '') : '';
          await fs.write(projectId, path, entry.content ?? '');
          if (path.endsWith('.sqlite') || path.endsWith('.db')) releaseDb(path);
          written.push({ path, existed, bytes: (entry.content || '').length, diff: unifiedDiff(before, entry.content ?? '', path) });
        }
        return ok(
          written.map((f) => `${f.existed ? 'Updated' : 'Created'} ${f.path} (${f.bytes} bytes)`).join('\n'),
          { kind: 'diff-many', files: written.map((f) => ({ path: f.path, diff: f.diff, created: !f.existed })) },
        );
      },
    },
    {
      name: 'scaffold',
      description:
        'Write a complete, working starter app in one call, costing no output tokens. Use it to start a new project (or a new section of one), then edit the files it creates to match the request. Available: ' +
        SCAFFOLD_IDS.join(', ') +
        '.',
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: SCAFFOLD_IDS },
          brand: { type: 'string', description: 'Product name to substitute into the markup.' },
          dir: { type: 'string', description: 'Optional subdirectory, e.g. "docs".' },
        },
        required: ['kind'],
      },
      mutating: true,
      async run({ kind, brand = '', dir = '' }) {
        let rendered;
        try {
          rendered = renderScaffold(kind, { brand });
        } catch (e) {
          return err(e.message);
        }
        const prefix = dir ? `${normPath(dir)}/` : '';
        const written = [];
        for (const [name, content] of Object.entries(rendered.files)) {
          const path = normPath(`${prefix}${name}`);
          await fs.write(projectId, path, content);
          written.push(path);
        }
        return ok(
          `Scaffolded ${SCAFFOLDS[kind].name} → ${written.join(', ')} (${rendered.lines} lines). It already works — ${rendered.blurb} Read what you need, then change only what the request asks for.`,
          { kind: 'scaffold', files: written, label: SCAFFOLDS[kind].name },
        );
      },
    },
    {
      name: 'write',
      description: 'Create or overwrite a file with the full content you want it to have.',
      schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
      mutating: true,
      async run({ file_path, content }) {
        const path = normPath(file_path);
        const existed = await fs.exists(projectId, path);
        const before = existed ? await fs.readText(projectId, path).catch(() => '') : '';
        await fs.write(projectId, path, content ?? '');
        if (path.endsWith('.sqlite') || path.endsWith('.db')) releaseDb(path);
        const diff = unifiedDiff(before, content ?? '', path);
        return ok(`${existed ? 'Updated' : 'Created'} ${path} (${(content || '').length} bytes)`, { kind: 'diff', path, diff, created: !existed });
      },
    },
    {
      name: 'edit',
      description: 'Replace one exact string in a file. old_string must appear exactly once unless replace_all is true.',
      schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      mutating: true,
      async run({ file_path, old_string, new_string, replace_all }) {
        const path = normPath(file_path);
        if (!(await fs.exists(projectId, path))) return err(`File not found: ${path}`);
        const before = await fs.readText(projectId, path);
        const count = before.split(old_string).length - 1;
        if (count === 0) return err(`old_string not found in ${path}. Read the file first.`);
        if (count > 1 && !replace_all) return err(`old_string appears ${count} times in ${path}. Add context or set replace_all.`);
        const after = replace_all ? before.split(old_string).join(new_string) : before.replace(old_string, new_string);
        await fs.write(projectId, path, after);
        return ok(`Edited ${path} (${count > 1 ? `${count} replacements` : '1 replacement'})`, { kind: 'diff', path, diff: unifiedDiff(before, after, path) });
      },
    },
    {
      name: 'multiedit',
      description: 'Apply several edits to one file in a single call.',
      schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['old_string', 'new_string'] } },
        },
        required: ['file_path', 'edits'],
      },
      mutating: true,
      async run({ file_path, edits = [] }) {
        const path = normPath(file_path);
        if (!(await fs.exists(projectId, path))) return err(`File not found: ${path}`);
        const before = await fs.readText(projectId, path);
        let text = before;
        for (const [i, edit] of edits.entries()) {
          if (!text.includes(edit.old_string)) return err(`edit ${i + 1}: old_string not found in ${path}`);
          text = text.replace(edit.old_string, edit.new_string);
        }
        await fs.write(projectId, path, text);
        return ok(`Applied ${edits.length} edits to ${path}`, { kind: 'diff', path, diff: unifiedDiff(before, text, path) });
      },
    },
    {
      name: 'ls',
      description: 'List the project tree (files and folders).',
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      readOnly: true,
      async run({ path = '' } = {}) {
        const dir = normPath(path);
        const nodes = await fs.tree(projectId);
        const filtered = dir ? nodes.filter((n) => n.path === dir || n.path.startsWith(`${dir}/`)) : nodes;
        return ok(filtered.map((n) => `${n.dir ? '📁' : '📄'} ${n.path}${n.dir ? '/' : ` (${n.size}b)`}`).join('\n') || '(empty project)', {
          kind: 'tree',
          nodes: filtered,
        });
      },
    },
    {
      name: 'glob',
      description: 'Find files by glob pattern (**/*.js, src/**/*.{ts,tsx}).',
      schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      readOnly: true,
      async run({ pattern }) {
        const hits = await fs.find(projectId, pattern);
        return ok(hits.join('\n') || 'No files matched.', { kind: 'files', files: hits });
      },
    },
    {
      name: 'grep',
      description: 'Search file contents with a regular expression (ripgrep-like).',
      schema: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
      readOnly: true,
      async run({ pattern, glob }) {
        const hits = await fs.search(projectId, pattern, { glob });
        return ok(hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') || 'No matches.', { kind: 'search', hits });
      },
    },
    {
      name: 'bash',
      description:
        'Run a shell command in the project (real shell built on the project filesystem: ls/cat/grep/find/sed-ish/node/npm/python/sqlite3/curl…). Returns stdout, stderr and the exit code.',
      schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
      mutating: true,
      async run({ command }) {
        ctx.beforeMutation?.(`bash: ${String(command).slice(0, 60)}`);
        const { code, output } = await shell.run(command, { onOutput: (chunk) => emit({ type: 'tool_output', text: chunk }) });
        return {
          text: truncate(output || '(no output)') + (code ? `\n[exit ${code}]` : ''),
          display: { kind: 'bash', command, exitCode: code },
          isError: code !== 0,
        };
      },
    },
    {
      name: 'todo_write',
      description: 'Maintain the task list. Keep every item’s status current — one in_progress at a time.',
      schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      readOnly: true,
      async run({ todos = [] }) {
        ctx.setTodos(todos);
        emit({ type: 'todos', todos });
        const done = todos.filter((t) => t.status === 'completed').length;
        return ok(`Todo list updated (${done}/${todos.length} complete).`, { kind: 'todos', todos });
      },
    },
    {
      name: 'task',
      description: 'Delegate a self-contained search/read task to a subagent with its own context. It returns a summary.',
      schema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          prompt: { type: 'string' },
          subagent_type: { type: 'string', enum: ['general', 'explore', 'plan'] },
        },
        required: ['description', 'prompt'],
      },
      readOnly: true,
      async run({ description, prompt, subagent_type }) {
        const result = await ctx.runSubagent({ description, prompt, subagentType: subagent_type || 'general' });
        return ok(`Subagent "${description}":\n\n${result.summary}`, { kind: 'subagent', description, steps: result.steps });
      },
    },
    {
      name: 'exit_plan_mode',
      description: 'Leave plan mode and present the plan for approval.',
      schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
      readOnly: true,
      async run({ plan }) {
        ctx.setPlan(plan);
        emit({ type: 'plan', plan });
        return ok('Plan submitted.');
      },
    },
    {
      name: 'web_fetch',
      description: 'Fetch a URL and return its text (subject to CORS — only public, CORS-enabled endpoints work from a browser).',
      schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      readOnly: true,
      async run({ url }) {
        if (!/^https?:\/\//i.test(url)) return err('Only absolute http(s) URLs are allowed.');
        try {
          const res = await fetch(url, { headers: { Accept: 'text/html,application/json,text/plain' } });
          const text = await res.text();
          const plain = /html/i.test(res.headers.get('content-type') || '')
            ? text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            : text;
          return ok(truncate(plain, 12_000), { kind: 'fetch', url, status: res.status });
        } catch (e) {
          return err(`Could not fetch ${url}: ${e.message}. Browsers block cross-origin requests that do not opt in with CORS.`);
        }
      },
    },
    {
      name: 'checkpoint',
      description: 'Snapshot the project so you can rewind to it later.',
      schema: { type: 'object', properties: { label: { type: 'string' } } },
      readOnly: true,
      async run({ label }) {
        const files = await fs.snapshot(projectId);
        const snap = await store.snapshot(projectId, files, label || 'checkpoint');
        return ok(`Checkpoint "${snap.label}" saved (${Object.keys(files).length} files).`, { kind: 'checkpoint', id: snap.id, label: snap.label });
      },
    },
    {
      name: 'runtime_info',
      description: 'Report what this browser runtime supports (filesystem, sqlite, python, node, deploy targets).',
      schema: { type: 'object', properties: {} },
      readOnly: true,
      async run() {
        return ok(JSON.stringify(ctx.runtimeInfo(), null, 2), { kind: 'runtime' });
      },
    },
    // ---- databases -------------------------------------------------------
    {
      name: 'db_list',
      description: 'List SQLite databases in the project.',
      schema: { type: 'object', properties: {} },
      readOnly: true,
      async run() {
        const files = await dbFiles(fs, projectId);
        return ok(files.map((f) => `${f.path} (${f.size} bytes)`).join('\n') || 'No database files yet. Create one by running SQL with the db_exec tool and a path.', {
          kind: 'db-list',
          files,
        });
      },
    },
    {
      name: 'db_schema',
      description: 'Inspect tables, columns and indexes of a SQLite database.',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      readOnly: true,
      async run({ path }) {
        const db = await getDb(path);
        return ok(JSON.stringify(db.schema(), null, 2), { kind: 'db-schema', path, schema: db.schema() });
      },
    },
    {
      name: 'db_query',
      description: 'Run a read-only SQL query (SELECT/PRAGMA/EXPLAIN).',
      schema: { type: 'object', properties: { path: { type: 'string' }, sql: { type: 'string' } }, required: ['path', 'sql'] },
      readOnly: true,
      async run({ path, sql }) {
        if (!isReadOnlySql(sql)) return err('db_query only runs read-only SQL. Use db_exec to write.');
        const db = await getDb(path);
        return ok(JSON.stringify(db.query(sql), null, 2), { kind: 'db-query', path, sql });
      },
    },
    {
      name: 'db_exec',
      description: 'Execute SQL that changes the database (CREATE/ALTER/INSERT/UPDATE/DELETE). Persists to the .sqlite file.',
      schema: { type: 'object', properties: { path: { type: 'string' }, sql: { type: 'string' } }, required: ['path', 'sql'] },
      mutating: true,
      async run({ path, sql }) {
        await ctx.beforeMutation?.(`db: ${String(sql).slice(0, 60)}`);
        const db = await getDb(path);
        const result = db.exec(sql);
        await saveDb(path, db);
        emit({ type: 'db_changed', path });
        return ok(JSON.stringify(result, null, 2), { kind: 'db-exec', path, sql, changes: result.changes });
      },
    },
    {
      name: 'db_rows',
      description: 'Read rows from a table with optional limit/offset/order/where.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          table: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
          order_by: { type: 'string' },
          where: { type: 'string' },
        },
        required: ['path', 'table'],
      },
      readOnly: true,
      async run({ path, table, limit, offset, order_by, where }) {
        const db = await getDb(path);
        const res = db.tableRows(table, { limit: limit || 50, offset: offset || 0, orderBy: order_by || '', where: where || '' });
        return ok(JSON.stringify(res, null, 2), { kind: 'db-rows', path, table });
      },
    },
    {
      name: 'db_update',
      description: 'Update one row by rowid.',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, table: { type: 'string' }, rowid: { type: 'number' }, changes: { type: 'object' } },
        required: ['path', 'table', 'rowid', 'changes'],
      },
      mutating: true,
      async run({ path, table, rowid, changes }) {
        const db = await getDb(path);
        const res = db.updateRow(table, rowid, changes);
        await saveDb(path, db);
        emit({ type: 'db_changed', path, table });
        return ok(JSON.stringify(res), { kind: 'db-write', path, table });
      },
    },
    {
      name: 'db_insert',
      description: 'Insert a row.',
      schema: { type: 'object', properties: { path: { type: 'string' }, table: { type: 'string' }, values: { type: 'object' } }, required: ['path', 'table', 'values'] },
      mutating: true,
      async run({ path, table, values }) {
        const db = await getDb(path);
        const res = db.insertRow(table, values);
        await saveDb(path, db);
        emit({ type: 'db_changed', path, table });
        return ok(JSON.stringify(res), { kind: 'db-write', path, table });
      },
    },
    {
      name: 'db_delete',
      description: 'Delete one row by rowid.',
      schema: { type: 'object', properties: { path: { type: 'string' }, table: { type: 'string' }, rowid: { type: 'number' } }, required: ['path', 'table', 'rowid'] },
      mutating: true,
      async run({ path, table, rowid }) {
        const db = await getDb(path);
        const res = db.deleteRow(table, rowid);
        await saveDb(path, db);
        emit({ type: 'db_changed', path, table });
        return ok(JSON.stringify(res), { kind: 'db-write', path, table });
      },
    },
    // ---- deployment ------------------------------------------------------
    {
      name: 'deploy',
      description:
        'Publish the project to the user’s own hosting. Opens the provider’s import flow for the repo the app just created, or returns a local preview link. Providers: cloudflare, vercel, netlify, preview.',
      schema: { type: 'object', properties: { target: { type: 'string', enum: ['preview', 'cloudflare', 'vercel', 'netlify'] }, project_name: { type: 'string' } } },
      async run({ target = 'preview', project_name }) {
        const result = await ctx.deploy({ target, projectName: project_name });
        return ok(result.message, { kind: 'deploy', ...result });
      },
    },
  ];

  /* ---- packages, background processes, MCP, the browser runtime ---------- */

  if (ctx.node) {
    tools.push({
      name: 'npm_install',
      description:
        'Install npm packages into the project (real packages, resolved at the edge and extracted in the tab). Use before importing a library instead of pasting a CDN script tag.',
      schema: { type: 'object', properties: { packages: { type: 'array', items: { type: 'string' } }, dev: { type: 'boolean' } }, required: ['packages'] },
      async run({ packages = [], dev = false }) {
        const resolved = dev ? packages.map((p) => `${p} --save-dev`) : packages;
        const result = await ctx.node.npmInstall({ add: resolved, log: (line) => emit?.({ type: 'tool_output', text: line }) });
        return { text: truncate(result.output), isError: result.code !== 0, display: { kind: 'npm', packages } };
      },
    });
    tools.push({
      name: 'job_start',
      description:
        'Start a background process (a real Web Worker) that keeps running while you work. Use for dev servers, watchers and long tasks. Returns a job id.',
      schema: { type: 'object', properties: { file: { type: 'string' }, command: { type: 'string' } }, required: ['file'] },
      async run({ file, command }) {
        if (!ctx.jobs) return err('background jobs are not available in this session');
        const job = ctx.jobs.start({ command: command || `node ${file}`, file, files: await ctx.snapshot?.() });
        return ok(`started job %${job.id}: ${job.command}
Use job_output %${job.id} to read the log, job_kill %${job.id} to stop it.`, { kind: 'job', job: ctx.jobs.describe(job) });
      },
    });
    tools.push({
      name: 'job_output',
      description: 'Read the log of a background job (and its status).',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        if (!ctx.jobs) return err('background jobs are not available');
        const job = ctx.jobs.get(id);
        if (!job) return err(`no job %${id}`);
        const state = ctx.jobs.describe(job);
        return ok(`%${job.id} ${state.status} (${(state.durationMs / 1000).toFixed(1)}s)\n${job.log.slice(-8000) || '(no output yet)'}`, { kind: 'job', job: state });
      },
    });
    tools.push({
      name: 'job_kill',
      description: 'Stop a background job.',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        if (!ctx.jobs) return err('background jobs are not available');
        return ctx.jobs.kill(id) ? ok(`stopped %${String(id).replace('%', '')}`) : err(`no job %${id}`);
      },
    });
  }

  // MCP tools are injected by the harness as `mcp__server__tool`, so the agent
  // can use any connected server without a special code path.
  if (Array.isArray(ctx.mcpTools)) tools.push(...ctx.mcpTools);

  if (ctx.allowDeploy === false) return tools.filter((t) => t.name !== 'deploy');
  return tools;
}

const READ_ONLY_TOOLS = new Set(['read', 'read_many', 'glob', 'grep', 'ls', 'web_fetch', 'job_output', 'db_list', 'db_schema', 'db_query', 'db_rows', 'runtime_info', 'todo_write', 'checkpoint', 'exit_plan_mode']);

export function toolsForMode(tools, mode, subagentType) {
  let list = tools;
  if (mode === 'plan') list = list.filter((t) => READ_ONLY_TOOLS.has(t.name));
  if (subagentType === 'explore' || subagentType === 'plan') list = list.filter((t) => READ_ONLY_TOOLS.has(t.name));
  if (subagentType) list = list.filter((t) => t.name !== 'task');
  return list;
}

export function toOpenAITools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
}

/** Human title for a tool call, used by the UI. */
export function toolTitle(name, args = {}) {
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
      return args.file_path || '';
    case 'read_many':
      return `${(args.paths || []).length} files`;
    case 'write_many':
      return `${(args.files || []).length} files`;
    case 'scaffold':
      return args.kind || 'app';
    case 'bash':
      return args.command || '';
    case 'grep':
      return args.pattern || '';
    case 'glob':
      return args.pattern || '';
    case 'task':
      return args.description || '';
    case 'deploy':
      return args.target || 'preview';
    case 'npm_install':
      return (args.packages || []).join(' ');
    case 'job_start':
      return args.command || args.file || '';
    case 'job_output':
    case 'job_kill':
      return `%${String(args.id || '').replace('%', '')}`;
    default:
      return '';
  }
}

export async function summarize(tool, out) {
  const display = out?.display;
  if (display?.kind === 'diff-many') {
    const files = display.files || [];
    const added = files.reduce((sum, f) => sum + (f.diff || '').split('\n').filter((l) => l.startsWith('+')).length, 0);
    const removed = files.reduce((sum, f) => sum + (f.diff || '').split('\n').filter((l) => l.startsWith('-')).length, 0);
    return `${files.length} files · +${added} −${removed}`;
  }
  if (display?.kind === 'scaffold') return `${display.label} · ${display.files.length} files`;
  if (display?.kind === 'read-many') return `${display.count} files read`;
  if (display?.kind === 'diff') {
    const added = (display.diff || '').split('\n').filter((l) => l.startsWith('+')).length;
    const removed = (display.diff || '').split('\n').filter((l) => l.startsWith('-')).length;
    return `+${added} −${removed} · ${display.path}`;
  }
  if (display?.kind === 'bash') return `exit ${display.exitCode}`;
  if (display?.kind === 'files') return `${display.files.length} files`;
  if (display?.kind === 'search') return `${display.hits.length} matches`;
  if (display?.kind === 'todos') return `${display.todos.length} todos`;
  const first = String(out?.text || '').split('\n')[0];
  return first.slice(0, 120);
}
