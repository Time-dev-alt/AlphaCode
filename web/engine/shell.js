/**
 * A real shell for the browser — implemented over the project filesystem.
 *
 * It is not bash and does not pretend to be: it parses quoting, pipes, `&&`,
 * `||`, `;`, redirection (`>`, `>>`) and `$VARS`, and implements the commands a
 * coding agent actually uses (`ls cat grep find rm mv cp mkdir node npm`…).
 * `node file.js` runs the module inside the page's realm with a CommonJS-ish
 * shim, `python` uses Pyodide when it is loaded, `sqlite3` uses sql.js — all
 * client-side, no server, no container.
 *
 * Every command is a pure async function (args, io) => exit code, so the whole
 * thing is unit-testable without a DOM.
 */

export const HELP = `commands:
  ls [path]              cd <path>       pwd            tree [path]
  cat <file...>          head -n N       tail -n N      wc -l <file>
  echo <text>            printf          touch <file>   mkdir -p <dir>
  rm [-rf] <path>        cp <src> <dst>  mv <src> <dst>
  grep <pat> [files]     find [glob]     du             stat <file>
  node <file.js> [args]  npm <cmd>       python <file>  sqlite3 <db> "<sql>"
  env                    export K=V      which <cmd>    clear
  help                   true / false    date           curl <url>  (same-origin / CORS only)`;

const MAX_OUTPUT = 200_000;

function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < line.length) {
        cur += line[++i];
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started || cur) tokens.push(cur);
      cur = '';
      started = false;
      continue;
    }
    if ('|&;<>'.includes(c)) {
      if (started || cur) tokens.push(cur);
      cur = '';
      started = false;
      const two = line.slice(i, i + 2);
      if (['&&', '||', '>>'].includes(two)) {
        tokens.push(two);
        i++;
      } else tokens.push(c);
      continue;
    }
    cur += c;
    started = true;
  }
  if (started || cur) tokens.push(cur);
  return tokens;
}

/** Split a token stream into pipelines joined by ; && ||. */
export function parse(line) {
  const tokens = tokenize(line);
  const chains = [];
  let current = { op: null, pipeline: [] };
  let command = [];
  let redirect = null;
  const flushCommand = () => {
    if (!command.length) return;
    current.pipeline.push({ argv: command, redirect });
    command = [];
    redirect = null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '|') {
      flushCommand();
    } else if (t === ';' || t === '&&' || t === '||') {
      flushCommand();
      if (current.pipeline.length) chains.push(current);
      current = { op: t, pipeline: [] };
    } else if (t === '>' || t === '>>') {
      redirect = { mode: t === '>>' ? 'append' : 'write', path: tokens[++i] || '' };
    } else {
      command.push(t);
    }
  }
  flushCommand();
  if (current.pipeline.length) chains.push(current);
  return chains;
}

export class Shell {
  /**
   * @param {object} deps
   * @param {import('./fs.js').FileSystem} deps.fs
   * @param {string} deps.projectId
   * @param {() => object} [deps.env]        extra environment
   * @param {(code: string) => Promise<string>} [deps.runPython]
   * @param {(db: string, sql: string) => Promise<string>} [deps.runSql]
   */
  constructor({ fs, projectId, env = () => ({}), runPython, runSql, fetchImpl } = {}) {
    this.fs = fs;
    this.projectId = projectId;
    this.env = env;
    this.runPython = runPython;
    this.runSql = runSql;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.cwd = '';
    this.vars = { HOME: '/', USER: 'agent', PWD: '/' };
    this.history = [];
  }

  abs(path) {
    if (!path) return this.cwd;
    if (path.startsWith('/')) return path.replace(/^\/+/, '');
    const base = this.cwd ? `${this.cwd}/` : '';
    const joined = `${base}${path}`;
    const parts = [];
    for (const seg of joined.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }

  expand(text) {
    return String(text).replace(/\$(\w+)|\$\{(\w+)\}/g, (_, a, b) => this.vars[a || b] ?? this.env()[a || b] ?? '');
  }

  async run(line, { onOutput = () => {} } = {}) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return { code: 0, output: '' };
    this.history.push(trimmed);
    const chains = parse(trimmed);
    let output = '';
    let code = 0;
    let carry = '';
    const emit = (text) => {
      if (!text) return;
      if (output.length < MAX_OUTPUT) output += text;
      onOutput(text);
    };
    for (const chain of chains) {
      if (chain.op === '&&' && code !== 0) continue;
      if (chain.op === '||' && code === 0) continue;
      let stdin = carry;
      for (const stage of chain.pipeline) {
        const res = await this.exec(stage.argv, { stdin });
        stdin = res.output;
        code = res.code;
        if (stage.redirect) {
          await this.writeOut(stage.redirect, res.output);
          stdin = '';
        } else if (chain.pipeline.length === 1 || stage === chain.pipeline.at(-1)) {
          emit(res.output);
        }
      }
      carry = stdin;
    }
    return { code, output: output.slice(0, MAX_OUTPUT) };
  }

  async writeOut(redirect, text) {
    const path = this.abs(redirect.path);
    if (redirect.mode === 'append') {
      const prev = (await this.fs.exists(this.projectId, path)) ? await this.fs.readText(this.projectId, path) : '';
      await this.fs.write(this.projectId, path, prev + text);
    } else {
      await this.fs.write(this.projectId, path, text);
    }
  }

  ok(output = '') {
    return { code: 0, output };
  }
  fail(output, code = 1) {
    return { code, output: output.endsWith('\n') ? output : `${output}\n` };
  }

  /** Resolve a possibly-globbed argument list to real file paths. */
  async resolveFiles(args) {
    const out = [];
    for (const arg of args) {
      const abs = this.abs(arg);
      if (/[*?{]/.test(arg)) {
        const hits = await this.fs.find(this.projectId, abs);
        out.push(...hits);
      } else out.push(abs);
    }
    return out;
  }

  async exec(argv, { stdin = '' } = {}) {
    const cmd = this.expand(argv[0] || '');
    const args = argv.slice(1).map((a) => this.expand(a));
    const fs = this.fs;
    const pid = this.projectId;

    switch (cmd) {
      case 'help':
        return this.ok(HELP + '\n');
      case 'true':
        return this.ok();
      case 'false':
        return { code: 1, output: '' };
      case 'clear':
        return this.ok('\u001b[2J\u001b[H');
      case 'pwd':
        return this.ok(`/${this.cwd}\n`);
      case 'cd': {
        const target = this.abs(args[0] || '');
        if (target) {
          const files = await fs.list(pid);
          const isDir = files.some((f) => f.path.startsWith(`${target}/`));
          if (!isDir) return this.fail(`cd: no such directory: ${args[0]}`);
        }
        this.cwd = target;
        this.vars.PWD = `/${target}`;
        return this.ok();
      }
      case 'ls': {
        const dir = this.abs(args.find((a) => !a.startsWith('-')) || '');
        const long = args.some((a) => /^-\w*l/.test(a));
        const all = await fs.list(pid);
        const entries = new Map();
        for (const f of all) {
          const rel = dir ? (f.path.startsWith(`${dir}/`) ? f.path.slice(dir.length + 1) : null) : f.path;
          if (rel === null) continue;
          const [head, ...rest] = rel.split('/');
          if (rest.length) entries.set(head, { dir: true });
          else entries.set(head, { dir: false, size: f.size });
        }
        if (!entries.size) return this.ok(dir ? '' : '');
        const names = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b));
        if (long) {
          return this.ok(names.map(([name, meta]) => `${meta.dir ? 'drwxr-xr-x' : '-rw-r--r--'} ${String(meta.size ?? 0).padStart(8)}  ${name}${meta.dir ? '/' : ''}`).join('\n') + '\n');
        }
        return this.ok(names.map(([name, meta]) => (meta.dir ? `${name}/` : name)).join('  ') + '\n');
      }
      case 'tree': {
        const files = await fs.list(pid);
        return this.ok(`${files.map((f) => f.path).join('\n')}\n`);
      }
      case 'cat': {
        if (!args.length) return this.ok(stdin);
        let out = '';
        for (const file of await this.resolveFiles(args)) {
          if (!(await fs.exists(pid, file))) return this.fail(`cat: ${file}: No such file`);
          out += await fs.readText(pid, file);
        }
        return this.ok(out);
      }
      case 'head':
      case 'tail': {
        const n = Number(args.find((a) => /^-\d+$/.test(a))?.slice(1) || args[args.indexOf('-n') + 1] || 10);
        const files = args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
        const text = files.length ? await fs.readText(pid, this.abs(files[0])) : stdin;
        const lines = text.split('\n');
        const slice = cmd === 'head' ? lines.slice(0, n) : lines.slice(-n);
        return this.ok(slice.join('\n'));
      }
      case 'wc': {
        const files = args.filter((a) => !a.startsWith('-'));
        const text = files.length ? await fs.readText(pid, this.abs(files[0])) : stdin;
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        return this.ok(`${lines}\t${text.length}\t${files[0] || '-'}\n`);
      }
      case 'echo':
        return this.ok(args.join(' ') + '\n');
      case 'printf':
        return this.ok(args.join(' ').replace(/\\n/g, '\n'));
      case 'date':
        return this.ok(new Date().toISOString() + '\n');
      case 'env':
        return this.ok(Object.entries({ ...this.env(), ...this.vars }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      case 'export': {
        for (const pair of args) {
          const [k, ...rest] = pair.split('=');
          if (k) this.vars[k] = rest.join('=');
        }
        return this.ok();
      }
      case 'which':
        return this.ok(`${args[0]}: shell builtin\n`);
      case 'touch': {
        for (const a of args) if (!(await fs.exists(pid, this.abs(a)))) await fs.write(pid, this.abs(a), '');
        return this.ok();
      }
      case 'mkdir': {
        const dirs = args.filter((a) => !a.startsWith('-'));
        if (!dirs.length) return this.fail('mkdir: missing operand');
        for (const d of dirs) await fs.write(pid, `${this.abs(d)}/.gitkeep`, '');
        return this.ok();
      }
      case 'rm': {
        const recursive = args.some((a) => /^-[rf]+$/.test(a) && a.includes('r'));
        const targets = args.filter((a) => !a.startsWith('-'));
        if (!targets.length) return this.fail('rm: missing operand');
        const files = await fs.list(pid);
        for (const t of targets) {
          const abs = this.abs(t);
          const isDir = files.some((f) => f.path.startsWith(`${abs}/`));
          if (isDir && !recursive) return this.fail(`rm: ${t}: is a directory (use -r)`);
          if (!isDir && !(await fs.exists(pid, abs))) return this.fail(`rm: ${t}: No such file`);
          await fs.remove(pid, abs);
        }
        return this.ok();
      }
      case 'cp':
      case 'mv': {
        const [from, to] = args.filter((a) => !a.startsWith('-'));
        if (!from || !to) return this.fail(`${cmd}: missing operand`);
        const src = this.abs(from);
        if (!(await fs.exists(pid, src))) return this.fail(`${cmd}: ${from}: No such file`);
        let dst = this.abs(to);
        if (to.endsWith('/')) dst = `${dst}/${from.split('/').pop()}`;
        await fs.move(pid, src, dst);
        return this.ok();
      }
      case 'grep': {
        const caseSensitive = args.includes('-i') ? false : true;
        const flags = args.filter((a) => a.startsWith('-'));
        const rest = args.filter((a) => !a.startsWith('-'));
        const pattern = rest.shift();
        if (!pattern) return this.fail('grep: missing pattern');
        let re;
        try {
          re = new RegExp(pattern, caseSensitive ? '' : 'i');
        } catch (err) {
          return this.fail(`grep: ${err.message}`);
        }
        const files = rest.length ? await this.resolveFiles(rest) : (await fs.list(pid)).map((f) => f.path);
        const out = [];
        for (const file of files) {
          if (!(await fs.exists(pid, file))) continue;
          const text = await fs.readText(pid, file).catch(() => '');
          if (text.includes('\0')) continue;
          text.split('\n').forEach((line, i) => {
            if (re.test(line)) {
              const prefix = flags.includes('-h') ? '' : `${file}:`;
              out.push(`${prefix}${flags.includes('-n') ? `${i + 1}:` : ''}${line}`);
            }
          });
          if (out.length > 500) break;
        }
        if (!out.length) return { code: 1, output: '' };
        return this.ok(`${out.slice(0, 500).join('\n')}\n`);
      }
      case 'find': {
        const pattern = args[0] && !args[0].startsWith('-') ? args[0] : '**/*';
        const hits = await fs.find(pid, pattern.startsWith('/') ? pattern.slice(1) : pattern);
        return this.ok(`${hits.join('\n')}\n`);
      }
      case 'du': {
        const files = await fs.list(pid);
        const total = files.reduce((s, f) => s + (f.size || 0), 0);
        return this.ok(`${total} bytes across ${files.length} files\n`);
      }
      case 'stat': {
        const path = this.abs(args[0] || '');
        if (!(await fs.exists(pid, path))) return this.fail(`stat: ${args[0]}: No such file`);
        const text = await fs.readText(pid, path);
        return this.ok(`File: ${path}\nSize: ${text.length} bytes\nLines: ${text.split('\n').length}\n`);
      }
      case 'node':
      case 'js': {
        const file = args.find((a) => !a.startsWith('-'));
        if (!file) return this.fail('node: specify a file to run (browser sandbox, not Node.js)');
        const abs = this.abs(file);
        if (!(await fs.exists(pid, abs))) return this.fail(`node: cannot find module '${file}'`);
        const source = await fs.readText(pid, abs);
        const logs = [];
        const sandboxConsole = {
          log: (...a) => logs.push(a.map(stringify).join(' ')),
          error: (...a) => logs.push(a.map(stringify).join(' ')),
          warn: (...a) => logs.push(a.map(stringify).join(' ')),
          info: (...a) => logs.push(a.map(stringify).join(' ')),
        };
        try {
          const module = { exports: {} };
          const requireShim = (name) => {
            if (name === './fs' || name === 'fs') return this.nodeFsShim();
            throw new Error(`Cannot require '${name}' in the browser sandbox (only relative files and fs)`);
          };
          // eslint-disable-next-line no-new-func
          const fn = new Function('module', 'exports', 'console', 'require', 'process', `${source}\n;return module.exports;`);
          const exported = fn(module, module.exports, sandboxConsole, requireShim, { env: { ...this.env(), ...this.vars }, argv: [abs, ...args.slice(1)] });
          if (exported && typeof exported.default === 'function') await exported.default();
          return this.ok(logs.length ? `${logs.join('\n')}\n` : '');
        } catch (err) {
          return this.fail(`${err?.name || 'Error'}: ${err?.message || err}`);
        }
      }
      case 'npm': {
        const sub = args[0] || '';
        if (['install', 'i', 'add', 'ci'].includes(sub)) {
          return this.ok(
            `npm: the browser sandbox has no package registry client.\n` +
              `      - For a static site, drop the dependency and use a CDN <script> or an import map.\n` +
              `      - For a real Node toolchain, connect a WebContainer runtime (see Settings → Runtime).\n`,
          );
        }
        if (sub === 'run') {
          const pkg = (await fs.exists(pid, 'package.json')) ? JSON.parse(await fs.readText(pid, 'package.json')) : { scripts: {} };
          const script = args[1];
          if (!script || !pkg.scripts?.[script]) return this.fail(`npm: missing script: ${script || '(none)'}`);
          const { code, output } = await this.run(pkg.scripts[script]);
          return { code, output };
        }
        return this.ok('npm: available commands in the browser sandbox: run <script>, install (explained)\n');
      }
      case 'python':
      case 'python3': {
        if (!this.runPython) return this.fail('python: runtime not loaded (Settings → Runtime → load Python)');
        const file = args.find((a) => !a.startsWith('-'));
        const code = file ? await fs.readText(pid, this.abs(file)).catch(() => null) : stdin;
        if (code === null) return this.fail(`python: can't open file '${file}'`);
        return this.ok(await this.runPython(code));
      }
      case 'sqlite3': {
        if (!this.runSql) return this.fail('sqlite3: engine not loaded');
        const [db, sql] = args;
        if (!db || !sql) return this.fail('sqlite3: usage: sqlite3 <db.sqlite> "<sql>"');
        return this.ok(await this.runSql(db, sql));
      }
      case 'curl': {
        const url = args.find((a) => /^https?:/.test(a));
        if (!url) return this.fail('curl: only absolute http(s) URLs are supported');
        try {
          const res = await this.fetchImpl(url);
          const text = await res.text();
          return this.ok(text.slice(0, 20_000));
        } catch (err) {
          return this.fail(`curl: ${err.message} (browsers only allow CORS-enabled endpoints)`);
        }
      }
      default:
        return this.fail(`${cmd}: command not found. Type \`help\` for the list.`, 127);
    }
  }

  nodeFsShim() {
    const fs = this.fs;
    const pid = this.projectId;
    return {
      readFileSync: () => {
        throw new Error('synchronous fs is not available in the browser sandbox');
      },
      promises: {
        readFile: (p) => fs.readText(pid, this.abs(p)),
        writeFile: (p, c) => fs.write(pid, this.abs(p), c),
        readdir: async (p) => {
          const dir = this.abs(p);
          const files = await fs.list(pid);
          return [...new Set(files.map((f) => f.path.slice(dir ? dir.length + 1 : 0).split('/')[0]).filter(Boolean))];
        },
      },
    };
  }
}

function stringify(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
