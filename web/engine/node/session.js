/**
 * The bridge between the project (OPFS/IndexedDB + the agent's tools) and the
 * Node runtime: hydrate a project into a runtime, run it, flush what changed.
 *
 * One session per project, kept alive so `npm install` is paid once and
 * `node`/`require` stay warm across commands.
 */
import { NodeRuntime } from './runtime.js';
import { NodeFS } from './vfs.js';
import { install, bindRuntimeWriter, humanBytes } from './npm.js';
import { fromBytes } from './vfs.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.next', 'dist', 'build', 'coverage', '__pycache__']);

export class NodeSession {
  constructor({ fs, projectId, onStdout = () => {}, onStderr = () => {}, env = {}, edge = '/api/npm' }) {
    this.fs = fs;
    this.projectId = projectId;
    this.edge = edge;
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.env = env;
    this.runtime = null;
    this.hydratedAt = 0;
    this.buffer = '';
  }

  /** Load the project into the runtime. Cheap enough to call on demand. */
  async hydrate({ force = false } = {}) {
    if (this.runtime && !force) return this.runtime;
    const files = await this.fs.snapshot(this.projectId).catch(() => ({}));
    const nodeFs = new NodeFS({ cwd: '/app' });
    const cleaned = {};
    for (const [path, content] of Object.entries(files)) {
      const top = path.split('/')[0];
      if (SKIP_DIRS.has(top) && top !== 'node_modules') continue;
      cleaned[path] = content;
    }
    nodeFs.hydrate(cleaned);
    this.runtime = new NodeRuntime({
      fs: nodeFs,
      onStdout: (text) => this.onStdout(text),
      onStderr: (text) => this.onStderr(text),
      env: this.env,
      cwd: '/app',
    });
    bindRuntimeWriter((target, data) => {
      try {
        this.runtime.fs.writeFile(`/app/${target}`, data);
      } catch {
        /* a package with odd paths should not abort the install */
      }
    });
    this.hydratedAt = Date.now();
    return this.runtime;
  }

  /**
   * Pull files the agent (or the editor) changed since the last run into the
   * runtime. Cheap: one directory listing and a stat comparison per file.
   */
  async syncFromProject() {
    if (!this.runtime) return this.hydrate();
    const files = await this.fs.list(this.projectId).catch(() => []);
    for (const file of files) {
      if (file.path.startsWith('node_modules/')) continue;
      const abs = this.runtime.fs.fromProjectPath(file.path);
      const existing = this.runtime.fs.files.get(abs);
      if (existing && existing.mtime >= (file.updatedAt || 0)) continue;
      if (existing && this.runtime.fs.dirty.has(abs)) continue; // pending runtime write wins
      try {
        const content = await this.fs.readText(this.projectId, file.path);
        if (existing && fromBytes(existing.data) === content) {
          existing.mtime = file.updatedAt || Date.now();
          continue;
        }
        this.runtime.fs.writeFile(abs, content, { silent: true });
      } catch {
        /* binary file — the runtime reads those lazily */
      }
    }
    return this.runtime;
  }

  /** Push runtime changes back into the project store. */
  async flush() {
    if (!this.runtime) return [];
    const written = [];
    for (const abs of this.runtime.fs.pendingWrites()) {
      const projectPath = this.runtime.fs.toProjectPath(abs);
      if (!projectPath) continue;
      const bytes = this.runtime.fs.readFile(abs);
      const text = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|mp3|zip|gz|wasm)$/i.test(abs) ? bytes : fromBytes(bytes);
      await this.fs.write(this.projectId, projectPath, text);
      written.push(projectPath);
    }
    for (const abs of this.runtime.fs.pendingDeletes()) {
      const projectPath = this.runtime.fs.toProjectPath(abs);
      if (!projectPath) continue;
      await this.fs.remove(this.projectId, projectPath).catch(() => {});
    }
    this.runtime.fs.clearDirty();
    return written;
  }

  /** `node <file>` — returns { code, output } like the shell expects. */
  async runFile(file, { args = [] } = {}) {
    const runtime = await this.syncFromProject();
    let output = '';
    runtime.onStdout = (t) => {
      output += t;
      this.onStdout(t);
    };
    runtime.onStderr = (t) => {
      output += t;
      this.onStderr(t);
    };
    runtime.argv = [file, ...args];
    try {
      runtime.run(file, { args });
      runtime.process.exitCode ??= 0;
      return { code: runtime.exitCode ?? runtime.process.exitCode ?? 0, output, error: null };
    } catch (err) {
      if (err?.isExit) return { code: err.code ?? 0, output, error: null };
      const text = `${err?.name === 'SyntaxError' ? 'SyntaxError' : err?.name || 'Error'}: ${err?.message || err}\n`;
      output += text;
      this.onStderr(text);
      return { code: 1, output, error: err };
    } finally {
      await this.flush();
    }
  }

  /** `node -e "<code>"` */
  async evalSource(code) {
    const runtime = await this.syncFromProject();
    let output = '';
    runtime.onStdout = (t) => {
      output += t;
      this.onStdout(t);
    };
    try {
      runtime.evaluateSource(code);
      await this.flush();
      return { code: 0, output };
    } catch (err) {
      const text = `${err?.name || 'Error'}: ${err?.message || err}\n`;
      this.onStderr(text);
      return { code: 1, output: output + text };
    }
  }

  async readPackageJson() {
    try {
      return JSON.parse(await this.fs.readText(this.projectId, 'package.json'));
    } catch {
      return null;
    }
  }

  /**
   * `npm install`, `npm install foo`, `npm install` with a lockfile present.
   * @returns {Promise<{code:number, output:string}>}
   */
  async npmInstall({ add = [], remove = [], log = () => {} } = {}) {
    const started = Date.now();
    const runtime = await this.syncFromProject();
    const existing = (await this.readPackageJson()) || { name: slug(this.projectId), version: '0.0.0', dependencies: {} };
    let result;
    try {
      result = await install({
        packageJson: existing,
        add,
        remove,
        edge: this.edge,
        onLog: (line) => log(`${line}\n`),
        onProgress: ({ done, total }) => {
          if (total >= 5 && done % 5 === 0) log(`· ${done}/${total}\n`);
        },
      });
    } catch (err) {
      return { code: 1, output: `npm ERR! ${err.message}\n` };
    }

    // node_modules went straight into the runtime fs; persist the metadata.
    runtime.fs.writeFile('/app/package.json', JSON.stringify(result.packageJson, null, 2) + '\n', { silent: false });
    runtime.fs.writeFile('/app/package-lock.json', JSON.stringify(result.lock, null, 2) + '\n');
    const written = await this.flush();

    const totalBytes = result.installed.reduce((sum, p) => sum + (p.bytes || 0), 0);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const lines = [
      ...(result.warnings || []).map((w) => `npm WARN ${w}`),
      `added ${result.installed.length} packages in ${seconds}s (${humanBytes(totalBytes)} extracted, ${written.length} files written)`,
      `resolved by the ${result.source === 'edge' ? 'edge cache' : 'browser'}${result.source === 'edge' ? ' — later installs are one request' : ''}`,
    ];
    return { code: 0, output: `${lines.join('\n')}\n` };
  }

  /** `npm run <script>` */
  async npmRun(script, { log = () => {} } = {}) {
    const pkg = await this.readPackageJson();
    const command = pkg?.scripts?.[script];
    if (!command) return { code: 1, output: `npm ERR! Missing script: "${script}"\n${pkg?.scripts ? `Available: ${Object.keys(pkg.scripts).join(', ')}\n` : ''}` };
    log(`> ${pkg.name || 'project'}@${pkg.version || '0.0.0'} ${script}\n> ${command}\n\n`);
    return { command, script };
  }

  /** Find the file a CLI binary maps to (for `npx <bin>`). */
  async binEntry(bin) {
    const runtime = await this.hydrate();
    const list = await this.listInstalled();
    const hit = list.find((p) => p.name === bin || p.name.split('/').pop() === bin);
    if (!hit) return null;
    const dir = `/app/node_modules/${hit.name}`;
    let manifest = {};
    try {
      manifest = JSON.parse(fromBytes(runtime.fs.readFile(`${dir}/package.json`)));
    } catch {
      return null;
    }
    const binField = manifest.bin;
    const relative = typeof binField === 'string' ? binField : binField?.[bin] || binField?.[Object.keys(binField || {})[0] || ''];
    if (!relative) return runtime.resolveFile(dir) ? `${dir}/${manifest.main || 'index.js'}` : null;
    return `${dir}/${String(relative).replace(/^\.\//, '')}`;
  }

  /** List installed packages, reading node_modules/package.json files. */
  async listInstalled() {
    const runtime = await this.hydrate();
    const dir = '/app/node_modules';
    if (!runtime.fs.isDir(dir)) return [];
    const out = [];
    const walk = (path, prefix) => {
      for (const entry of runtime.fs.readdir(path, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory()) {
          if (prefix && !prefix.startsWith('@')) continue;
          if (entry.name.startsWith('@')) {
            walk(child, entry.name);
            continue;
          }
          try {
            const manifest = JSON.parse(fromBytes(runtime.fs.readFile(`${child}/package.json`)));
            out.push({ name: manifest.name || entry.name, version: manifest.version || '0.0.0', description: manifest.description || '' });
          } catch {
            /* not a package dir */
          }
          walk(child, prefix ? '' : '');
        }
      }
    };
    walk(dir, '');
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

const slug = (text) => String(text).replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'project';

export function createNodeSession(options) {
  return new NodeSession(options);
}
