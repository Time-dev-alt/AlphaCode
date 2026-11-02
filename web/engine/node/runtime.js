/**
 * A Node-compatible runtime that lives in a tab.
 *
 * What is real: `require`, `import` semantics for packages, `node_modules`
 * resolution, `package.json` `exports`/`main`/`module`/`browser`, the `fs` API
 * against the project files, `process`, `Buffer`, streams, crypto digests,
 * zlib, `http` over fetch, and stdout that streams to the terminal live.
 *
 * What is not: native addons, worker threads, sockets, signals, and synchronous
 * child processes. Each of those fails with a message that names the escape
 * hatch, because a stack trace that says "not a function" is worse than a
 * sentence that says "a tab cannot do this; do X instead".
 */
import { NodeFS, fromBytes, toBytes } from './vfs.js';
import { createBuiltins, installBuiltins, EventEmitter } from './builtins.js';
import { esmToCjs, looksEsm } from './transform.js';

const EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];
const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs', 'index.json'];
const MODULE_CACHE = new Map();

class Module {
  constructor(id, parent) {
    this.id = id;
    this.filename = id;
    this.path = id.slice(0, id.lastIndexOf('/')) || '/';
    this.exports = {};
    this.loaded = false;
    this.children = [];
    this.parent = parent || null;
  }
}

export class NodeRuntime {
  /**
   * @param {object} options
   * @param {import('./vfs.js').NodeFS} [options.fs]
   * @param {(text: string) => void} [options.onStdout]
   * @param {(text: string) => void} [options.onStderr]
   * @param {Record<string,string>} [options.env]
   * @param {string} [options.cwd]
   */
  constructor({ fs, onStdout = () => {}, onStderr = () => {}, env = {}, cwd = '/app', argv = [] } = {}) {
    this.fs = fs || new NodeFS({ cwd });
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.env = { NODE_ENV: 'development', HOME: '/home/agent', ...env };
    this.argv = argv;
    this.exitCode = null;
    this.timers = new Set();
    this.moduleCache = new Map();
    this.process = this.makeProcess();
    this.builtins = createBuiltins({
      fs: this.fs,
      process: this.process,
      // Late-bound: `NodeSession` swaps these per run to collect output, and a
      // captured reference would send every `console.log` to the wrong place.
      stdout: (text) => this.onStdout(text),
      stderr: (text) => this.onStderr(text),
      resolve: (spec, from) => this.resolve(spec, from),
    });
    installBuiltins(this.builtins);
    // A few packages read these from the global scope.
    this.globals = {
      process: this.process,
      Buffer: this.Buffer,
      global: globalThis,
      __dirname: this.fs.cwd,
      __filename: `${this.fs.cwd}/index.js`,
    };
  }

  get Buffer() {
    return this.builtins.buffer.Buffer;
  }

  /* ------------------------------------------------------------- process -- */

  makeProcess() {
    const emitter = new EventEmitter();
    const started = Date.now();
    const self = this;
    const process = Object.assign(emitter, {
      title: 'node',
      version: 'v22.11.0',
      versions: { node: '22.11.0', v8: '12.4.0', npm: '10.9.0', modules: '127' },
      platform: 'linux',
      arch: 'x64',
      release: { name: 'node' },
      env: this.env,
      argv: ['node', ...this.argv],
      execArgv: [],
      argv0: 'node',
      pid: 1,
      ppid: 0,
      exitCode: undefined,
      browser: true,
      cwd: () => self.fs.cwd,
      chdir: (dir) => {
        const next = self.fs.normalize(dir);
        if (!self.fs.isDir(next)) {
          const err = new Error(`ENOENT: no such file or directory, chdir '${dir}'`);
          err.code = 'ENOENT';
          throw err;
        }
        self.fs.cwd = next;
      },
      exit: (code = 0) => {
        self.exitCode = code;
        process.exitCode = code;
        emitter.emit('exit', code);
        throw new ExitError(code);
      },
      abort: () => process.exit(1),
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      off: emitter.off.bind(emitter),
      emit: emitter.emit.bind(emitter),
      emitWarning: (warning) => self.onStderr(`(node) warning: ${warning}\n`),
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
      setImmediate: (fn, ...args) => setTimeout(() => fn(...args), 0),
      clearImmediate: (timer) => clearTimeout(timer),
      hrtime: Object.assign((previous) => {
        const now = performance.now() * 1e6;
        const seconds = Math.floor(now / 1e9);
        const nanos = Math.floor(now % 1e9);
        if (!previous) return [seconds, nanos];
        return [seconds - previous[0], nanos - previous[1]];
      }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
      uptime: () => (Date.now() - started) / 1000,
      memoryUsage: () => ({ rss: 50 * 1024 * 1024, heapTotal: 30 * 1024 * 1024, heapUsed: 12 * 1024 * 1024, external: 1024 * 1024, arrayBuffers: 512 * 1024 }),
      cpuUsage: () => ({ user: 0, system: 0 }),
      resourceUsage: () => ({ maxRSS: 0, userCPUTime: 0, systemCPUTime: 0 }),
      getuid: () => 1000,
      getgid: () => 1000,
      geteuid: () => 1000,
      getegid: () => 1000,
      umask: () => 0o22,
      kill: () => {},
      disconnect: () => {},
      connected: false,
      send: () => false,
      stdout: {
        write: (chunk) => {
          self.onStdout(typeof chunk === 'string' ? chunk : fromBytes(toBytes(chunk)));
          return true;
        },
        isTTY: false,
        columns: 100,
        rows: 30,
        on() {},
        end() {},
      },
      stderr: {
        write: (chunk) => {
          self.onStderr(typeof chunk === 'string' ? chunk : fromBytes(toBytes(chunk)));
          return true;
        },
        isTTY: false,
        columns: 100,
        on() {},
        end() {},
      },
      stdin: { isTTY: false, on() {}, read() { return null; }, resume() {}, pause() {} },
    });
    return process;
  }

  /* ------------------------------------------------------------ resolve -- */

  resolve(spec, fromFile) {
    const from = fromFile?.startsWith('/') ? fromFile : this.fs.normalize(fromFile || this.fs.cwd);
    const fromDir = from.endsWith('/') ? from : from.slice(0, from.lastIndexOf('/')) || '/';
    const name = String(spec);

    if (name.startsWith('node:')) return `builtin:${name.slice(5)}`;
    if (this.builtins[name]) return `builtin:${name}`;

    if (name.startsWith('./') || name.startsWith('../') || name === '.' || name === '..' || name.startsWith('/')) {
      const abs = this.fs.normalize(name, fromDir);
      const found = this.resolveFile(abs);
      if (found) return found;
      throw moduleNotFound(name, from);
    }

    // bare specifier → walk node_modules up the tree
    const segments = name.split('/');
    const isScoped = name.startsWith('@');
    const packageName = isScoped ? segments.slice(0, 2).join('/') : segments[0];
    const subpath = isScoped ? segments.slice(2).join('/') : segments.slice(1).join('/');

    let dir = fromDir;
    while (dir) {
      const candidate = this.fs.normalize(`node_modules/${packageName}`, dir);
      if (this.fs.isDir(candidate) || this.fs.isFile(candidate)) {
        if (subpath) {
          const file = this.resolveFile(this.fs.normalize(subpath, candidate));
          if (file) return file;
        }
        const entry = this.resolvePackage(candidate, subpath);
        if (entry) return entry;
      }
      const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
      if (parent === dir) break;
      dir = parent;
    }
    throw moduleNotFound(name, from);
  }

  resolvePackage(packageDir, subpath = '') {
    const pkgPath = `${packageDir}/package.json`;
    let pkg = null;
    try {
      pkg = JSON.parse(fromBytes(this.fs.readFile(pkgPath)));
    } catch {
      pkg = null;
    }
    if (pkg) {
      const target = subpath ? `./${subpath}` : '.';
      const exported = pickExports(pkg.exports, target);
      if (exported) {
        const file = this.resolveFile(this.fs.normalize(exported, packageDir));
        if (file) return file;
      }
      if (!subpath) {
        const candidates = [];
        if (typeof pkg.browser === 'string') candidates.push(pkg.browser);
        if (pkg.module) candidates.push(pkg.module);
        if (pkg.main) candidates.push(pkg.main);
        candidates.push('index.js');
        for (const candidate of candidates) {
          const file = this.resolveFile(this.fs.normalize(candidate, packageDir));
          if (file) return file;
        }
      }
    }
    return this.resolveFile(packageDir);
  }

  resolveFile(abs) {
    const trail = [
      abs,
      ...EXTENSIONS.map((ext) => `${abs}${ext}`),
      ...INDEX_FILES.map((file) => `${abs}/${file}`),
    ];
    for (const candidate of trail) {
      const normalized = this.fs.normalize(candidate);
      if (this.fs.isFile(normalized)) return normalized;
    }
    return null;
  }

  /* -------------------------------------------------------------- loading -- */

  require(spec, parentFile) {
    const resolved = this.resolve(spec, parentFile);
    if (resolved.startsWith('builtin:')) return this.builtins[resolved.slice(8)];

    const cached = this.moduleCache.get(resolved);
    if (cached) return cached.exports;

    const module = new Module(resolved, parentFile);
    this.moduleCache.set(resolved, module);
    MODULE_CACHE.set(`${this.fs.root}:${resolved}`, module);

    if (resolved.endsWith('.json')) {
      module.exports = JSON.parse(fromBytes(this.fs.readFile(resolved)));
      module.loaded = true;
      return module.exports;
    }

    const source = fromBytes(this.fs.readFile(resolved));
    this.evaluate(module, source, resolved);
    module.loaded = true;
    return module.exports;
  }

  evaluate(module, source, filename) {
    const isEsm = /\.mjs$/.test(filename) || (looksEsm(source) && !/\.cjs$/.test(filename));
    let code = source;
    if (isEsm) {
      try {
        code = esmToCjs(source, { filename }).code;
      } catch (err) {
        throw new Error(`${filename}: ${err.message}`);
      }
    }
    // Strip a shebang and a byte-order mark.
    code = code.replace(/^\uFEFF/, '').replace(/^#!.*\n/, '\n');
    const localRequire = (spec) => this.require(spec, filename);
    localRequire.resolve = (spec) => this.resolve(spec, filename);
    localRequire.cache = Object.fromEntries(this.moduleCache);
    localRequire.main = this.mainModule || module;

    let factory;
    try {
      factory = new Function(
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
        '__require',
        '__exports',
        'process',
        'Buffer',
        'global',
        'console',
        'setImmediate',
        'clearImmediate',
        `${code}\n//# sourceURL=${encodeURI(filename)}`,
      );
    } catch (err) {
      throw new SyntaxError(`${filename}: ${err.message}${/await/.test(err.message) ? ' (top-level await is not supported — wrap it in an async function)' : ''}`);
    }

    factory.call(
      module.exports,
      module.exports,
      localRequire,
      module,
      filename,
      module.path,
      localRequire,
      module.exports,
      this.process,
      this.Buffer,
      globalThis,
      this.builtins.console,
      (fn, ...args) => setTimeout(() => fn(...args), 0),
      (timer) => clearTimeout(timer),
    );
    return module.exports;
  }

  /* ---------------------------------------------------------------- entry -- */

  /**
   * Run a file (or inline source) and return its exports + captured output.
   * @param {string} file
   * @param {object} [options]
   */
  run(file, { code: inline, args = [] } = {}) {
    const abs = inline ? '<inline>' : this.fs.normalize(file);
    const module = new Module(abs, null);
    this.mainModule = module;
    if (inline) {
      this.moduleCache.set(abs, module);
      this.evaluate(module, inline, abs);
    } else {
      if (!this.fs.isFile(abs)) {
        const err = new Error(`Cannot find module '${file}'`);
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      this.require(abs);
      return this.moduleCache.get(abs)?.exports;
    }
    return module.exports;
  }

  /** Run arbitrary source with `require` available (REPL, `node -e`). */
  evaluateSource(source, filename = '<eval>') {
    const module = new Module(filename, null);
    this.moduleCache.set(filename, module);
    this.evaluate(module, source, filename);
    return module.exports;
  }

  /** Flush files the runtime changed back to the project store. */
  async flush(write, remove) {
    const changed = [];
    for (const path of this.fs.pendingWrites()) {
      const projectPath = this.fs.toProjectPath(path);
      if (projectPath === null) continue;
      const bytes = this.fs.readFile(path);
      const text = isProbablyText(path) ? fromBytes(bytes) : bytes;
      await write(projectPath, text);
      changed.push({ path: projectPath, bytes: bytes.byteLength });
    }
    for (const path of this.fs.pendingDeletes()) {
      const projectPath = this.fs.toProjectPath(path);
      if (projectPath === null) continue;
      await remove(projectPath);
    }
    this.fs.clearDirty();
    return changed;
  }
}

export class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.name = 'ExitError';
    this.code = code;
    this.isExit = true;
  }
}

const moduleNotFound = (name, from) => {
  const err = new Error(`Cannot find module '${name}'\nRequire stack:\n- ${from}\n\nRun \`npm install ${name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')}\` to add it.`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
};

const isProbablyText = (path) => !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|mp3|zip|gz|wasm)$/i.test(path);

/** `exports` field → a file path, or null. */
function pickExports(exportsField, target) {
  if (!exportsField) return null;
  const conditions = ['browser', 'import', 'module', 'require', 'default'];
  const walk = (value, depth = 0) => {
    if (value === null || depth > 4) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === 'object') {
      for (const condition of conditions) {
        if (value[condition] !== undefined) {
          const found = walk(value[condition], depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    return null;
  };
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return target === '.' ? walk(exportsField) : null;
  if (typeof exportsField === 'object') {
    const keys = Object.keys(exportsField);
    const isSubpathMap = keys.some((key) => key.startsWith('.'));
    if (!isSubpathMap) return target === '.' ? walk(exportsField) : null;
    if (exportsField[target]) return walk(exportsField[target]);
    // wildcard subpaths: "./*": "./dist/*.js"
    for (const key of keys) {
      if (!key.includes('*')) continue;
      const [prefix, suffix] = key.split('*');
      if (target.startsWith(prefix) && target.endsWith(suffix || '')) {
        const middle = target.slice(prefix.length, target.length - (suffix || '').length);
        const resolved = walk(exportsField[key]);
        if (resolved) return resolved.replace('*', middle);
      }
    }
    return null;
  }
  return null;
}

export { NodeFS, fromBytes, toBytes };
