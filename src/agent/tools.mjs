/**
 * The AlphaCode tool suite — a Claude-Code-class toolset plus deploy, database
 * and runtime superpowers.
 *
 * Every tool is a plain object: { name, description, schema, readOnly, run }.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  listTree,
  readFileSafe,
  writeFileSafe,
  deleteSafe,
  findFiles,
  searchFiles,
  resolveReal,
  toRel,
  projectWorkspace,
} from '../runtime/paths.mjs';
import { runCommand, dangerousCommand, which } from '../runtime/exec.mjs';
import { unifiedDiff } from '../runtime/git.mjs';
import { detect, prepareProject, readPins } from '../runtime/runtimes.mjs';
import { dbFiles, openSqlite, sqliteSchema, sqliteQuery, tableRows, updateRow, deleteRow, insertRow, isReadOnlySql } from '../runtime/database.mjs';
import { bad, forbidden } from '../lib/http.mjs';
import { config } from '../config.mjs';
import { log } from '../lib/log.mjs';

const json = (obj) => JSON.stringify(obj);

function truncate(text, limit = config.agent.toolOutputLimit) {
  const s = typeof text === 'string' ? text : String(text);
  if (s.length <= limit) return { text: s, truncated: false };
  const head = s.slice(0, Math.floor(limit * 0.7));
  const tail = s.slice(-Math.floor(limit * 0.25));
  return {
    text: `${head}\n\n… [${s.length - head.length - tail.length} characters truncated] …\n\n${tail}`,
    truncated: true,
  };
}

function numbered(content, startLine = 1) {
  const lines = content.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width, ' ')}→${l}`).join('\n');
}

// ------------------------------------------------------------ background ----
export const backgroundShells = new Map();
let shellSeq = 0;

// -------------------------------------------------------------- tool defs ---
export function buildTools(ctx) {
  const tools = [];
  const add = (t) => tools.push(t);

  add({
    name: 'read',
    description:
      'Read a file from the project workspace. Returns line-numbered content. Always read a file before editing it. Use offset/limit for very large files.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to the project root (or absolute inside it)' },
        offset: { type: 'number', description: '1-based line to start at' },
        limit: { type: 'number', description: 'Maximum number of lines to return (default 2000)' },
      },
      required: ['file_path'],
    },
    async run({ file_path, offset = 1, limit = 2000 }) {
      const file = await readFileSafe(ctx.projectId, file_path, 8 * 1024 * 1024);
      const lines = file.content.split('\n');
      const start = Math.max(1, Number(offset) || 1);
      const end = Math.min(lines.length, start + Math.max(1, Number(limit) || 2000) - 1);
      const slice = lines.slice(start - 1, end).join('\n');
      const meta = `(${file.path} — ${lines.length} lines, ${file.size} bytes)`;
      return {
        text: slice.length ? `${numbered(slice, start)}\n\n${meta}` : `${meta}\n(empty file)`,
        display: { kind: 'read', path: file.path, lines: end - start + 1 },
      };
    },
  });

  add({
    name: 'write',
    description:
      'Write a file to the workspace, creating parent directories as needed. Overwrites existing files — prefer edit for small changes to existing files.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['file_path', 'content'],
    },
    async run({ file_path, content }) {
      const abs = await resolveReal(ctx.projectId, file_path);
      let before = null;
      try {
        before = await fsp.readFile(abs, 'utf8');
      } catch {}
      await ctx.beforeMutation(`write ${file_path}`);
      const res = await writeFileSafe(ctx.projectId, file_path, content);
      const diff = unifiedDiff(before ?? '', content, res.path);
      return {
        text: `${before === null ? 'Created' : 'Updated'} ${res.path} (${res.bytes} bytes, ${content.split('\n').length} lines).`,
        display: { kind: 'diff', path: res.path, diff: before === null ? `--- /dev/null\n+++ b/${res.path}\n${diffLines(content)}` : diff, created: before === null },
      };
    },
  });

  add({
    name: 'edit',
    description:
      'Replace an exact string in a file. old_string must match the file byte-for-byte including whitespace and indentation. Fails if old_string is not unique unless replace_all is true. Read the file first.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async run({ file_path, old_string, new_string, replace_all = false }) {
      const file = await readFileSafe(ctx.projectId, file_path, 8 * 1024 * 1024);
      const content = file.content;
      if (old_string === new_string) throw bad('old_string and new_string are identical — nothing to do');
      const count = countOccurrences(content, old_string);
      if (count === 0) {
        throw bad(
          `old_string was not found in ${file.path}. Re-read the file and copy the exact text, including indentation.`,
        );
      }
      if (count > 1 && !replace_all) {
        throw bad(
          `old_string occurs ${count} times in ${file.path}. Provide more surrounding context to make it unique, or set replace_all: true.`,
        );
      }
      const next = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
      await ctx.beforeMutation(`edit ${file_path}`);
      await writeFileSafe(ctx.projectId, file_path, next);
      const added = new_string.split('\n').length;
      return {
        text: `Edited ${file.path} (${count} replacement${count === 1 ? '' : 's'}, +${added} line block).`,
        display: { kind: 'diff', path: file.path, diff: unifiedDiff(content, next, file.path), replacements: count },
      };
    },
  });

  add({
    name: 'multiedit',
    description: 'Apply several sequential exact-string edits to one file in a single call. Each edit is applied in order.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['file_path', 'edits'],
    },
    async run({ file_path, edits }) {
      const file = await readFileSafe(ctx.projectId, file_path, 8 * 1024 * 1024);
      let content = file.content;
      const before = content;
      let applied = 0;
      for (const [i, e] of (edits || []).entries()) {
        const c = countOccurrences(content, e.old_string);
        if (c === 0) throw bad(`Edit #${i + 1} failed: old_string not found. No changes were written.`);
        if (c > 1 && !e.replace_all) throw bad(`Edit #${i + 1} failed: old_string appears ${c} times. No changes were written.`);
        content = e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, e.new_string);
        applied++;
      }
      await ctx.beforeMutation(`multiedit ${file_path}`);
      await writeFileSafe(ctx.projectId, file_path, content);
      return {
        text: `Applied ${applied} edits to ${file.path}.`,
        display: { kind: 'diff', path: file.path, diff: unifiedDiff(before, content, file.path) },
      };
    },
  });

  add({
    name: 'notebook_edit',
    description: 'Edit a Jupyter notebook (.ipynb) cell source, insert a new cell, or delete a cell.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        cell_id: { type: 'string', description: 'Cell id or index' },
        new_source: { type: 'string' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      },
      required: ['notebook_path', 'new_source', 'edit_mode'],
    },
    async run({ notebook_path, cell_id, new_source, cell_type = 'code', edit_mode = 'replace' }) {
      const file = await readFileSafe(ctx.projectId, notebook_path, 16 * 1024 * 1024);
      let nb;
      try {
        nb = JSON.parse(file.content);
      } catch {
        throw bad('Not a valid .ipynb notebook');
      }
      const cells = nb.cells || [];
      const idx = findCell(cells, cell_id);
      if (edit_mode === 'insert') {
        cells.splice(idx + 1, 0, { cell_type, metadata: {}, source: new_source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n')), outputs: [], execution_count: null });
      } else if (edit_mode === 'delete') {
        if (idx < 0) throw bad('Cell not found');
        cells.splice(idx, 1);
      } else {
        if (idx < 0) throw bad('Cell not found');
        cells[idx].source = new_source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'));
        if (cell_type && cells[idx].cell_type !== cell_type) cells[idx].cell_type = cell_type;
      }
      nb.cells = cells;
      await ctx.beforeMutation(`notebook ${notebook_path}`);
      await writeFileSafe(ctx.projectId, notebook_path, JSON.stringify(nb, null, 1));
      return { text: `Notebook ${notebook_path} updated (${edit_mode}, ${cells.length} cells).`, display: { kind: 'write', path: notebook_path } };
    },
  });

  add({
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.test.js". Returns paths sorted by modification time.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Optional subdirectory to search' } },
      required: ['pattern'],
    },
    async run({ pattern, path: sub }) {
      const prefix = sub ? String(sub).replace(/^\.?\//, '').replace(/\/$/, '') + '/' : '';
      const files = await findFiles(ctx.projectId, prefix + pattern, { limit: 300 });
      if (!files.length) return { text: `No files matched ${pattern}.` };
      const withTimes = await Promise.all(
        files.map(async (f) => {
          try {
            const st = await fsp.stat(path.join(projectWorkspace(ctx.projectId), f.path));
            return { ...f, mtime: st.mtimeMs };
          } catch {
            return { ...f, mtime: 0 };
          }
        }),
      );
      withTimes.sort((a, b) => b.mtime - a.mtime);
      return { text: withTimes.map((f) => f.path).join('\n'), display: { kind: 'files', files: withTimes.map((f) => f.path) } };
    },
  });

  add({
    name: 'grep',
    description:
      'Search file contents with a regular expression (ripgrep semantics). Use output_mode "files_with_matches" for a quick inventory, "content" for matching lines with line numbers.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string', description: 'Filter files, e.g. "*.ts"' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        case_insensitive: { type: 'boolean' },
        head_limit: { type: 'number' },
        context: { type: 'number', description: 'Lines of surrounding context (content mode)' },
      },
      required: ['pattern'],
    },
    async run({ pattern, path: sub, glob, output_mode = 'content', case_insensitive = false, head_limit = 120, context = 0 }) {
      const rg = await which('rg');
      const scope = sub ? path.join(projectWorkspace(ctx.projectId), sub) : projectWorkspace(ctx.projectId);
      if (rg) {
        const flags = ['-n', '--no-heading', '--color', 'never', '-m', '400'];
        if (case_insensitive) flags.push('-i');
        if (glob) flags.push('-g', JSON.stringify(glob));
        if (context) flags.push('-C', String(Math.min(10, Number(context) || 0)));
        if (output_mode === 'files_with_matches') flags.push('-l');
        else if (output_mode === 'count') flags.push('-c');
        const res = await runCommand(`rg ${flags.join(' ')} -e ${JSON.stringify(pattern)} ${JSON.stringify(scope)} 2>&1 | head -n ${Number(head_limit) || 120}`, {
          timeoutMs: 30000,
          cwd: ctx.projectDir,
        });
        const out = res.output.replaceAll(ctx.projectDir + '/', '').replaceAll(scope + '/', '');
        return { text: out.trim() || `No matches for ${pattern}.`, display: { kind: 'grep', pattern } };
      }
      const results = await searchFiles(ctx.projectId, pattern, { glob, limit: Number(head_limit) || 120, caseSensitive: !case_insensitive });
      if (!results.length) return { text: `No matches for ${pattern}.` };
      if (output_mode === 'files_with_matches') return { text: [...new Set(results.map((r) => r.path))].join('\n') };
      if (output_mode === 'count') {
        const counts = new Map();
        for (const r of results) counts.set(r.path, (counts.get(r.path) || 0) + 1);
        return { text: [...counts.entries()].map(([p, n]) => `${p}:${n}`).join('\n') };
      }
      return { text: results.map((r) => `${r.path}:${r.line}: ${r.text}`).join('\n') };
    },
  });

  add({
    name: 'ls',
    description: 'List the contents of a directory in the workspace (non-recursive unless depth is given).',
    readOnly: true,
    schema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' } }, required: [] },
    async run({ path: sub = '.', depth = 1 }) {
      const tree = await listTree(ctx.projectId, { maxDepth: Math.min(4, Number(depth) || 1) });
      const prefix = String(sub || '.').replace(/^\.\/?/, '').replace(/\/$/, '');
      const filtered = tree.filter((e) => (prefix ? e.path.startsWith(prefix + '/') || e.path === prefix : true));
      const maxDepth = prefix ? prefix.split('/').length + Math.min(4, Number(depth) || 1) : Math.min(4, Number(depth) || 1);
      const rows = filtered.filter((e) => e.path.split('/').length <= maxDepth);
      if (!rows.length) return { text: `Directory ${sub} is empty.` };
      const text = rows
        .map((e) => {
          const indent = '  '.repeat(e.path.split('/').length - 1);
          return `${indent}${path.basename(e.path)}${e.dir ? '/' : ` (${formatSize(e.size || 0)})`}`;
        })
        .join('\n');
      return { text, display: { kind: 'ls', path: sub } };
    },
  });

  add({
    name: 'bash',
    description:
      'Run a shell command in the project workspace using a real bash shell. Use for builds, tests, package managers, git and servers. Long-running commands: set run_in_background true and poll with bash_output.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string', description: 'Short human-readable description of what this does' },
        timeout_ms: { type: 'number', description: 'Max runtime (default 180000, capped at 900000)' },
        run_in_background: { type: 'boolean' },
      },
      required: ['command'],
    },
    async run({ command, description = '', timeout_ms, run_in_background = false }) {
      if (!command || typeof command !== 'string') throw bad('command is required');
      const risks = dangerousCommand(command);
      if (risks.length) {
        const verdict = await ctx.requestPermission({
          kind: 'bash',
          title: description || command.slice(0, 80),
          command,
          risks,
        });
        if (!verdict.approved) return { text: `Permission denied by the user for: ${command}`, isError: true };
      } else {
        await ctx.emit({ type: 'notice', level: 'info', text: `$ ${command.slice(0, 160)}` });
      }
      const timeout = Math.min(900000, Math.max(1000, Number(timeout_ms) || config.shell.timeoutMs));

      if (run_in_background) {
        const id = `shell_${++shellSeq}`;
        const child = ctx.spawnBackground(command);
        backgroundShells.set(id, child);
        return {
          text: `Started background shell ${id} (${description || command.slice(0, 60)}). Poll it with bash_output.`,
          display: { kind: 'bash', command, background: id },
        };
      }

      let streamed = '';
      const res = await runCommand(command, {
        cwd: ctx.projectDir,
        timeoutMs: timeout,
        signal: ctx.signal,
        onData: (chunk) => {
          streamed += chunk;
          if (streamed.length < 200_000) ctx.emit({ type: 'tool_output', text: chunk.slice(-4000) });
        },
      });
      const out = truncate(res.output.trim() || '(no output)');
      const meta = res.timedOut
        ? `\n\n[timed out after ${Math.round(timeout / 1000)}s]`
        : res.code !== 0
          ? `\n\n[exit code ${res.code}]`
          : '';
      return {
        text: out.text + meta,
        isError: res.code !== 0,
        display: { kind: 'bash', command, exitCode: res.code, durationMs: res.durationMs, timedOut: res.timedOut },
      };
    },
  });

  add({
    name: 'bash_output',
    description: 'Read buffered output from a background shell started with bash (run_in_background).',
    readOnly: true,
    schema: { type: 'object', properties: { shell_id: { type: 'string' }, wait_ms: { type: 'number' } }, required: ['shell_id'] },
    async run({ shell_id, wait_ms = 0 }) {
      const bg = backgroundShells.get(shell_id);
      if (!bg) throw bad(`Unknown background shell: ${shell_id}`);
      if (wait_ms) await new Promise((r) => setTimeout(r, Math.min(15000, Number(wait_ms) || 0)));
      const out = bg.drain();
      return { text: `${out || '(no new output)'}\n\n[status: ${bg.alive ? 'running' : `exited ${bg.exitCode}`}]` };
    },
  });

  add({
    name: 'kill_shell',
    description: 'Terminate a background shell started with bash.',
    readOnly: false,
    schema: { type: 'object', properties: { shell_id: { type: 'string' } }, required: ['shell_id'] },
    async run({ shell_id }) {
      const bg = backgroundShells.get(shell_id);
      if (!bg) throw bad(`Unknown background shell: ${shell_id}`);
      bg.kill();
      backgroundShells.delete(shell_id);
      return { text: `Killed ${shell_id}.` };
    },
  });

  add({
    name: 'todo_write',
    description:
      'Create or update the session todo list. Use for any task with 3+ steps. Keep exactly one item in_progress; mark items completed immediately as you finish them.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async run({ todos }) {
      if (!Array.isArray(todos)) throw bad('todos must be an array');
      ctx.setTodos(todos.slice(0, 50));
      await ctx.emit({ type: 'todos', todos });
      const done = todos.filter((t) => t.status === 'completed').length;
      return { text: `Todo list updated (${done}/${todos.length} complete).`, display: { kind: 'todos', todos } };
    },
  });

  add({
    name: 'task',
    description:
      'Delegate a task to a subagent with its own context window. subagent_type: "general-purpose" (can edit files), "explore" (read-only codebase search), "plan" (read-only planning). Use this for broad research so the main context stays clean.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3-6 word task label' },
        prompt: { type: 'string', description: 'Complete, self-contained instructions for the subagent' },
        subagent_type: { type: 'string', enum: ['general-purpose', 'explore', 'plan'] },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
    async run({ description, prompt, subagent_type }) {
      const result = await ctx.runSubagent({ description, prompt, subagentType: subagent_type });
      return { text: result.summary, display: { kind: 'task', description, subagent: subagent_type, steps: result.steps } };
    },
  });

  add({
    name: 'exit_plan_mode',
    description: 'Present a finished implementation plan to the user for approval. Only use in plan mode.',
    readOnly: true,
    schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
    async run({ plan }) {
      ctx.setPlan(plan);
      await ctx.emit({ type: 'plan', plan });
      return { text: 'Plan presented to the user. Wait for approval before executing.', display: { kind: 'plan', plan } };
    },
  });

  add({
    name: 'web_fetch',
    description: 'Fetch a URL and return its readable text. Use for documentation, API references and error messages.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: { url: { type: 'string' }, prompt: { type: 'string', description: 'What to extract' } },
      required: ['url'],
    },
    async run({ url }) {
      const proto = new URL(url).protocol;
      if (!['http:', 'https:'].includes(proto)) throw bad('Only http(s) URLs are allowed');
      if (isPrivateHost(new URL(url).hostname)) throw forbidden('Refusing to fetch a private/internal address');
      const res = await fetch(url, { headers: { 'User-Agent': 'AlphaCode/2.0 (+https://github.com/Time-dev-alt/Nex)' }, signal: AbortSignal.timeout(25000) });
      const ct = res.headers.get('content-type') || '';
      if (!/text|json|xml|javascript/i.test(ct)) return { text: `Skipped non-text response (${ct})` };
      const raw = await res.text();
      const text = ct.includes('html') ? htmlToText(raw) : raw;
      const out = truncate(text, 30_000);
      return { text: `HTTP ${res.status} · ${ct}\n\n${out.text}`, display: { kind: 'webfetch', url, status: res.status } };
    },
  });

  add({
    name: 'web_search',
    description: 'Search the web for current information (documentation, versions, errors). Returns titles, URLs and snippets.',
    readOnly: true,
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run({ query }) {
      const results = await webSearch(String(query));
      if (!results.length) return { text: `No results for "${query}".` };
      return {
        text: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'),
        display: { kind: 'search', query, results },
      };
    },
  });

  add({
    name: 'deploy',
    description:
      'Deploy the project. target: "cloudflare" | "netlify" | "vercel" | "preview". With a saved provider token it publishes to the user\'s account; without one it creates a claimable preview URL the user must claim.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['cloudflare', 'netlify', 'vercel', 'preview'] }, project_name: { type: 'string' } },
      required: ['target'],
    },
    async run({ target, project_name }) {
      const result = await ctx.deploy({ target, projectName: project_name });
      return { text: result.message, display: { kind: 'deploy', ...result.display } };
    },
  });

  add({
    name: 'db_list',
    description: 'List SQLite databases in the workspace and any external database connections configured for this user.',
    readOnly: true,
    schema: { type: 'object', properties: {} },
    async run() {
      const files = dbFiles(ctx.projectId);
      const external = ctx.externalConnections || [];
      const lines = [];
      lines.push(files.length ? `SQLite databases:\n${files.map((f) => `- ${f.path} (${formatSize(f.size)})`).join('\n')}` : 'No SQLite databases found in the workspace.');
      if (external.length) lines.push(`External connections:\n${external.map((c) => `- ${c.name} (${c.engine}${c.readOnly ? ', read-only' : ''})`).join('\n')}`);
      return { text: lines.join('\n\n'), display: { kind: 'db_list', files } };
    },
  });

  add({
    name: 'db_schema',
    description: 'Describe a database: tables, columns, types and row counts. Pass a workspace path for SQLite or an external connection name.',
    readOnly: true,
    schema: { type: 'object', properties: { database: { type: 'string' } }, required: ['database'] },
    async run({ database }) {
      assertSqlite(ctx, database);
      const handle = await openSqlite(ctx.projectId, database);
      const schema = sqliteSchema(handle);
      const text = schema.tables
        .map((t) => `${t.type.toUpperCase()} ${t.name} (${t.rows} rows)\n${t.columns.map((c) => `  - ${c.name} ${c.type || ''}${c.pk ? ' PK' : ''}${c.notNull ? ' NOT NULL' : ''}`).join('\n')}`)
        .join('\n\n');
      return { text: text || 'Database has no tables yet.', display: { kind: 'db_schema', schema } };
    },
  });

  add({
    name: 'db_query',
    description: 'Run a read-only SQL query against a SQLite database in the workspace and return rows.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: { database: { type: 'string' }, sql: { type: 'string' }, limit: { type: 'number' } },
      required: ['database', 'sql'],
    },
    async run({ database, sql, limit = 200 }) {
      assertSqlite(ctx, database);
      if (!isReadOnlySql(sql)) throw bad('db_query only runs read-only statements. Use db_exec for writes.');
      const handle = await openSqlite(ctx.projectId, database);
      const res = sqliteQuery(handle, sql);
      const rows = (res.rows || []).slice(0, Number(limit) || 200);
      const text = tableToText(res.columns || [], rows);
      return { text: `${res.rowCount} row(s) in ${res.durationMs}ms\n\n${text}`, display: { kind: 'db_rows', columns: res.columns, rows } };
    },
  });

  add({
    name: 'db_exec',
    description:
      'Execute a write statement (INSERT/UPDATE/DELETE/DDL) against a SQLite database in the workspace. Requires the workspace database path; a checkpoint is taken first.',
    readOnly: false,
    schema: { type: 'object', properties: { database: { type: 'string' }, sql: { type: 'string' } }, required: ['database', 'sql'] },
    async run({ database, sql }) {
      assertSqlite(ctx, database);
      await ctx.beforeMutation('db_exec');
      const handle = await openSqlite(ctx.projectId, database);
      const res = sqliteQuery(handle, sql);
      return { text: `Statement executed. ${res.changes ?? 0} row(s) changed.`, display: { kind: 'db_exec', sql, changes: res.changes } };
    },
  });

  add({
    name: 'db_rows',
    description: 'Page through the rows of a table (read-only) for inspection or to find the row you want to change.',
    readOnly: true,
    schema: {
      type: 'object',
      properties: {
        database: { type: 'string' },
        table: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
        order_by: { type: 'string' },
      },
      required: ['database', 'table'],
    },
    async run({ database, table, limit = 50, offset = 0, order_by }) {
      assertSqlite(ctx, database);
      const handle = await openSqlite(ctx.projectId, database);
      const res = tableRows(handle, table, { limit, offset, orderBy: order_by });
      return { text: tableToText(res.columns, res.rows), display: { kind: 'db_rows', ...res } };
    },
  });

  add({
    name: 'db_update',
    description: 'Update a single row by rowid in a SQLite table (safer than raw SQL for small edits).',
    readOnly: false,
    schema: {
      type: 'object',
      properties: {
        database: { type: 'string' },
        table: { type: 'string' },
        rowid: { type: 'number' },
        values: { type: 'object' },
      },
      required: ['database', 'table', 'rowid', 'values'],
    },
    async run({ database, table, rowid, values }) {
      assertSqlite(ctx, database);
      await ctx.beforeMutation('db_update');
      const handle = await openSqlite(ctx.projectId, database);
      const res = updateRow(handle, table, rowid, values);
      return { text: `Updated ${res.changes} row(s) in ${table}.`, display: { kind: 'db_exec', changes: res.changes } };
    },
  });

  add({
    name: 'db_insert',
    description: 'Insert a row into a SQLite table.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: { database: { type: 'string' }, table: { type: 'string' }, values: { type: 'object' } },
      required: ['database', 'table', 'values'],
    },
    async run({ database, table, values }) {
      assertSqlite(ctx, database);
      await ctx.beforeMutation('db_insert');
      const handle = await openSqlite(ctx.projectId, database);
      const res = insertRow(handle, table, values);
      return { text: `Inserted row ${res.rowid} into ${table}.`, display: { kind: 'db_exec', changes: res.changes } };
    },
  });

  add({
    name: 'db_delete',
    description: 'Delete a single row by rowid from a SQLite table.',
    readOnly: false,
    schema: {
      type: 'object',
      properties: { database: { type: 'string' }, table: { type: 'string' }, rowid: { type: 'number' } },
      required: ['database', 'table', 'rowid'],
    },
    async run({ database, table, rowid }) {
      assertSqlite(ctx, database);
      await ctx.beforeMutation('db_delete');
      const handle = await openSqlite(ctx.projectId, database);
      const res = deleteRow(handle, table, rowid);
      return { text: `Deleted ${res.changes} row(s) from ${table}.`, display: { kind: 'db_exec', changes: res.changes } };
    },
  });

  add({
    name: 'runtime_info',
    description: 'Show the detected Node.js, npm, Python, git and database toolchain versions plus any version pins in the project.',
    readOnly: true,
    schema: { type: 'object', properties: {} },
    async run() {
      const info = await detect();
      const pins = await readPins(ctx.projectDir);
      return {
        text: json({ node: info.node, npm: info.npm, python: info.python, tools: info.tools, pins: { node: pins.node, python: pins.python, framework: pins.framework } }, null, 2),
        display: { kind: 'runtime', info },
      };
    },
  });

  add({
    name: 'install_deps',
    description: 'Install project dependencies (npm/pnpm/yarn for package.json, pip into .venv for requirements.txt / pyproject.toml).',
    readOnly: false,
    schema: { type: 'object', properties: {} },
    async run() {
      const logs = [];
      const result = await prepareProject(ctx.projectDir, (line) => {
        logs.push(line);
        ctx.emit({ type: 'tool_output', text: line });
      });
      const failed = result.steps.filter((s) => s.ok === false);
      return {
        text: `Dependency install finished${failed.length ? ` with ${failed.length} failing step(s)` : ' successfully'}.\n${logs.slice(-40).join('\n')}`,
        isError: failed.length > 0,
        display: { kind: 'install', steps: result.steps },
      };
    },
  });

  add({
    name: 'checkpoint',
    description: 'Create a git checkpoint of the workspace before risky work so the user can rewind to it.',
    readOnly: false,
    schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    async run({ label }) {
      const sha = await ctx.checkpoint(label);
      return { text: sha ? `Checkpoint "${label}" created at ${sha.slice(0, 7)}.` : 'Checkpoint unavailable (git not initialised).' };
    },
  });

  return tools;
}

function diffLines(content) {
  return String(content)
    .split('\n')
    .map((l) => '+' + l)
    .join('\n');
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function findCell(cells, cellId) {
  if (cellId === undefined || cellId === null || cellId === '') return -1;
  const asNum = Number(cellId);
  if (Number.isInteger(asNum) && asNum >= 0 && asNum < cells.length) return asNum;
  return cells.findIndex((c) => c.id === cellId);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function tableToText(columns, rows) {
  if (!rows?.length) return '(no rows)';
  const cols = columns?.length ? columns : Object.keys(rows[0]);
  const widths = cols.map((c) => Math.min(40, Math.max(String(c).length, ...rows.map((r) => String(r[c] ?? 'NULL').length))));
  const line = (cells) => cells.map((c, i) => String(c ?? '').slice(0, widths[i]).padEnd(widths[i])).join(' | ');
  return [line(cols), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map((r) => line(cols.map((c) => (r[c] === null ? 'NULL' : r[c]))))].join('\n');
}

function assertSqlite(ctx, database) {
  const files = dbFiles(ctx.projectId).map((f) => f.path);
  if (!files.includes(String(database))) {
    const hint = files.length ? `Known databases: ${files.join(', ')}` : 'No SQLite databases exist yet — create one with write (.db) and a table, or use db_exec on a new path.';
    // allow new paths that end with a sqlite extension
    if (!/\.(db|sqlite|sqlite3|db3)$/i.test(String(database))) throw bad(`Unknown database "${database}". ${hint}`);
  }
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1') return true;
  return /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function webSearch(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlphaCode/2.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 8) {
      results.push({
        url: decodeURIComponent(m[1].replace(/^\/\/duckduckgo.com\/l\/\?uddg=/, '').split('&rut=')[0]),
        title: htmlToText(m[2]),
        snippet: htmlToText(m[3]).slice(0, 300),
      });
    }
    return results;
  } catch (err) {
    log.debug('web search failed', err.message);
    return [];
  }
}

/** Convert tool definitions into OpenAI function schemas. */
export function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema,
    },
  }));
}

/** Subagents are restricted by type — read-only tools only for explore/plan. */
export function toolsForMode(tools, mode, subagentType) {
  const READ_ONLY = new Set(['read', 'glob', 'grep', 'ls', 'web_fetch', 'web_search', 'db_list', 'db_schema', 'db_query', 'db_rows', 'runtime_info', 'todo_write', 'bash_output', 'checkpoint']);
  let list = tools;
  if (mode === 'plan') list = list.filter((t) => READ_ONLY.has(t.name) || t.name === 'exit_plan_mode');
  if (subagentType === 'explore' || subagentType === 'plan') list = list.filter((t) => READ_ONLY.has(t.name));
  if (subagentType) list = list.filter((t) => t.name !== 'task'); // no recursive subagents
  return list;
}
