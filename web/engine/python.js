/**
 * Real CPython in the tab (Pyodide).
 *
 * Not a Python-subset interpreter: this is CPython 3.12 compiled to WebAssembly
 * with numpy, pandas, matplotlib, sqlite3, JS interop and `micropip`. We mount
 * the project at `/app`, run with that as the working directory, and sync
 * whatever the script wrote back into the project store.
 *
 * The first load is ~10 MB (CDN-cached, done lazily the first time the agent or
 * the terminal needs Python); after that every run is a warm interpreter.
 */

const DEFAULT_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';

let loading = null;
let instance = null;

/** Load (or reuse) Pyodide. */
export async function loadPython({ indexURL = DEFAULT_INDEX, onProgress = () => {} } = {}) {
  if (instance) return instance;
  if (loading) return loading;
  loading = (async () => {
    onProgress({ phase: 'download', message: 'downloading CPython (WASM)…' });
    const script = await loadScript(`${indexURL}pyodide.js`);
    void script;
    // eslint-disable-next-line no-undef
    const pyodide = await loadPyodide({
      indexURL,
      stdout: (line) => queueMicrotask(() => pendingStdout?.(`${line}\n`)),
      stderr: (line) => queueMicrotask(() => pendingStderr?.(`${line}\n`)),
    });
    onProgress({ phase: 'ready', message: `Python ${pyodide.runPython('import sys; sys.version.split()[0]')}` });
    instance = pyodide;
    return pyodide;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw new Error(`Python could not start: ${err.message}`);
  }
}

let pendingStdout = null;
let pendingStderr = null;

function loadScript(src) {
  if (typeof document === 'undefined') return Promise.reject(new Error('no document to load the Pyodide script'));
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-pyodide]`);
    if (existing) return resolve(existing);
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.pyodide = '1';
    script.onload = () => resolve(script);
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

export const pythonReady = () => Boolean(instance);

/* ------------------------------------------------------------ file sync -- */

const toFsPath = (path) => `/app/${path}`.replace(/\/+/g, '/');

function ensureDir(pyodide, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cursor = '';
  for (const part of parts) {
    cursor += `/${part}`;
    try {
      pyodide.FS.mkdir(cursor);
    } catch {
      /* exists */
    }
  }
}

export function mountFiles(pyodide, files) {
  ensureDir(pyodide, '/app');
  for (const [path, content] of Object.entries(files || {})) {
    if (/^(node_modules|\.git)\//.test(path)) continue;
    const target = toFsPath(path);
    const dir = target.slice(0, target.lastIndexOf('/'));
    if (dir) ensureDir(pyodide, dir);
    try {
      pyodide.FS.writeFile(target, typeof content === 'string' ? content : new Uint8Array(content));
    } catch {
      /* binary or too large — skip */
    }
  }
}

/** Read /app back out of the interpreter's filesystem. */
export function readFiles(pyodide, { ignore = ['/app/node_modules'] } = {}) {
  const out = {};
  const walk = (dir) => {
    let entries;
    try {
      entries = pyodide.FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === '.' || name === '..' || name === '__pycache__') continue;
      const full = `${dir}/${name}`;
      if (ignore.some((prefix) => full.startsWith(prefix))) continue;
      let stat;
      try {
        stat = pyodide.FS.stat(full);
      } catch {
        continue;
      }
      if (pyodide.FS.isDir(stat.mode)) {
        walk(full);
        continue;
      }
      try {
        const data = pyodide.FS.readFile(full);
        const text = new TextDecoder().decode(data);
        out[full.replace(/^\/app\/?/, '')] = text.includes('\uFFFD') ? data : text;
      } catch {
        /* unreadable */
      }
    }
  };
  walk('/app');
  return out;
}

/* ----------------------------------------------------------------- run --- */

/**
 * Run Python with the project mounted at /app.
 *
 * @param {object} options
 * @param {string} [options.code]       inline source
 * @param {string} [options.file]       project file to execute
 * @param {string[]} [options.args]
 * @param {Record<string,string>} [options.files] project snapshot
 * @param {(text:string)=>void} [options.onOutput]
 * @param {(delta:object)=>void} [options.onFiles]  changed files, for persistence
 */
export async function runPython({ code, file, args = [], files = {}, onOutput = () => {}, onFiles, indexURL, signal } = {}) {
  const pyodide = await loadPython({ indexURL, onProgress: (p) => onOutput(`[${p.phase}] ${p.message}\n`) });
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  pendingStdout = onOutput;
  pendingStderr = onOutput;
  try {
    mountFiles(pyodide, files);
    pyodide.FS.chdir('/app');
    pyodide.globals.set('_alphacode_argv', [file || '<string>', ...args]);
    pyodide.runPython('import sys; sys.argv = list(_alphacode_argv)');
    const source = code ?? pyodide.FS.readFile(toFsPath(file), { encoding: 'utf8' });
    const result = await pyodide.runPythonAsync(source, { filename: file || '<stdin>' });
    let text = '';
    if (result !== undefined && result !== null) text = String(result);
    if (text) onOutput(`${text}\n`);
    if (onFiles) {
      const after = readFiles(pyodide);
      const changed = {};
      for (const [path, content] of Object.entries(after)) {
        if (files[path] !== content) changed[path] = content;
      }
      if (Object.keys(changed).length) await onFiles(changed);
    }
    return { code: 0, output: text, error: null };
  } catch (err) {
    const message = formatPythonError(err);
    onOutput(message);
    return { code: 1, output: message, error: err };
  } finally {
    pendingStdout = null;
    pendingStderr = null;
  }
}

function formatPythonError(err) {
  const text = String(err?.message || err);
  // Pyodide prefixes a JS traceback; keep the Python part.
  const python = text.split('\n').filter((line) => !/^\s*at .*\(.*\)$/.test(line)).join('\n');
  return python.endsWith('\n') ? python : `${python}\n`;
}

/** `pip install` through micropip. */
export async function pipInstall(packages, { onOutput = () => {}, indexURL } = {}) {
  const pyodide = await loadPython({ indexURL, onProgress: (p) => onOutput(`[${p.phase}] ${p.message}\n`) });
  await pyodide.loadPackage('micropip');
  const micropip = pyodide.pyimport('micropip');
  const installed = [];
  for (const spec of packages) {
    onOutput(`Installing ${spec}…\n`);
    try {
      await micropip.install(spec);
      installed.push(spec);
    } catch (err) {
      onOutput(`error: ${err.message}\n`);
      return { code: 1, installed };
    }
  }
  onOutput(`installed ${installed.length} package${installed.length === 1 ? '' : 's'}\n`);
  return { code: 0, installed };
}

export async function pythonInfo() {
  if (!instance) return { ready: false };
  const version = instance.runPython('import sys; sys.version.split()[0]');
  const compiled = instance.runPython('__import__("platform").python_compiler()');
  return { ready: true, version, compiled, packages: ['numpy', 'pandas', 'matplotlib', 'sqlite3', 'pyodide', 'micropip'] };
}

/** Reset the interpreter (used by the terminal's `reset` and by tests). */
export async function resetPython() {
  instance = null;
  loading = null;
}
