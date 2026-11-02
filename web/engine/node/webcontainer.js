/**
 * WebContainers — real Node.js and npm, in the tab, from StackBlitz.
 *
 * AlphaCode already ships two Node paths:
 *   • the built-in runtime (`engine/node/`) — pure-JS packages, instant, no
 *     download, but native-addon-free and no real process model;
 *   • Nodepod — a fuller npm resolver, still our own runtime underneath.
 *
 * Neither is `node` itself. WebContainers *is*: a WebAssembly port of Node with
 * a POSIX-ish filesystem, a real process table, and npm running for real, so a
 * Vite/Next/Express project behaves the way it does on a laptop — including
 * `npm run dev` serving a live URL.
 *
 * Requirements, which is why this is opt-in rather than the default:
 *   • `crossOriginIsolated === true`, i.e. the page must be served with
 *     `Cross-Origin-Opener-Policy: same-origin` and
 *     `Cross-Origin-Embedder-Policy: credentialless`. `functions/_middleware.js`
 *     sets those for a visitor who has turned the sandbox on (cookie
 *     `nex_wc=1`), because tightening them globally would break OAuth popups and
 *     some CDN assets in generated previews;
 *   • a Chromium-family browser or Firefox 121+; Safari cannot boot it yet, and
 *     the UI says so instead of failing silently;
 *   • the SDK from a CDN — it is not part of the bundle, so the 3 MB only
 *     downloads if the user asks for it.
 *
 * Nothing here touches the project files until `boot()` is called, and every
 * file written inside the container is mirrored back through `onFileWritten`.
 */

/** Pinned: a WebContainers major can change the boot protocol. */
export const WEBCONTAINER_VERSION = '1.5.1';
export const WEBCONTAINER_CDN = `https://esm.sh/@webcontainer/api@${WEBCONTAINER_VERSION}`;

export const webcontainerSupported = () =>
  typeof window !== 'undefined' && Boolean(window.crossOriginIsolated) && typeof SharedArrayBuffer === 'function';

export function webcontainerDiagnosis() {
  if (typeof window === 'undefined') return { ok: false, reason: 'no browser here' };
  if (typeof SharedArrayBuffer !== 'function') return { ok: false, reason: 'this browser has no SharedArrayBuffer' };
  if (!window.crossOriginIsolated) {
    return {
      ok: false,
      reason: 'the page is not cross-origin isolated',
      hint: 'Turn on “Node sandbox” in Settings → Runtimes and reload; that adds the two headers WebContainers needs.',
    };
  }
  return { ok: true, reason: 'ready' };
}

/** Files the container should never receive from the project snapshot. */
const SKIP = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', 'coverage']);

/**
 * Turn the project's flat `{path: text}` map into the nested tree the mount API
 * wants. Binary entries are skipped — the container asks npm for those anyway.
 */
export function toFileTree(files = {}) {
  const root = {};
  for (const [path, content] of Object.entries(files)) {
    const parts = String(path).split('/').filter(Boolean);
    if (!parts.length || SKIP.has(parts[0])) continue;
    if (typeof content !== 'string') continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node[name] || node[name].directory === undefined) node[name] = { directory: {} };
      node = node[name].directory;
    }
    node[parts[parts.length - 1]] = { file: { contents: content } };
  }
  return root;
}

/**
 * Read back every text file under a directory, as a flat map.
 * Used to mirror what `npm run build` produced into the project.
 */
export async function readTree(container, dir = '/', { limit = 400, ignore = SKIP } = {}) {
  const out = {};
  const walk = async (abs, depth) => {
    if (Object.keys(out).length >= limit || depth > 8) return;
    let entries;
    try {
      entries = await container.fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignore.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = `${abs.replace(/\/$/, '')}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (Object.keys(out).length < limit) {
        try {
          const text = await container.fs.readFile(child, 'utf-8');
          out[child.replace(/^\//, '')] = text;
        } catch {
          /* binary file — the container keeps it, the project does not need it */
        }
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/**
 * One container per tab. Booting twice throws in the SDK, so the promise is
 * cached and shared.
 */
let booting = null;
let container = null;

export function currentContainer() {
  return container;
}

/**
 * Boot (once) and mount the project.
 *
 * @param {object} options
 * @param {Record<string,string>} options.files  project snapshot
 * @param {(line:string)=>void} [options.onOutput]
 * @param {(url:string, port:number)=>void} [options.onServerReady]
 * @param {(path:string, contents:string)=>void} [options.onFileWritten]
 * @returns {Promise<object>} the WebContainer instance
 */
export async function bootWebContainer({ files = {}, onOutput = () => {}, onServerReady = () => {}, onFileWritten = null } = {}) {
  const diagnosis = webcontainerDiagnosis();
  if (!diagnosis.ok) {
    const error = new Error(`WebContainers cannot start: ${diagnosis.reason}.`);
    error.hint = diagnosis.hint;
    throw error;
  }
  if (!booting) {
    booting = (async () => {
      const { WebContainer } = await import(/* @vite-ignore */ WEBCONTAINER_CDN);
      const instance = await WebContainer.boot({ coep: 'credentialless' });
      instance.on('server-ready', (port, url) => onServerReady(url, port));
      if (onFileWritten) {
        instance.fs.watch?.('/', (_event, filename) => {
          if (!filename || SKIP.has(String(filename).split('/')[0]) || String(filename).startsWith('node_modules')) return;
          instance.fs
            .readFile(`/${filename}`, 'utf-8')
            .then((contents) => onFileWritten(String(filename), contents))
            .catch(() => {});
        });
      }
      container = instance;
      return instance;
    })().catch((err) => {
      booting = null;
      throw err;
    });
  }
  const instance = await booting;
  if (Object.keys(files).length) await instance.mount(toFileTree(files));
  return instance;
}

/** Stream a process's output into a callback (used by install and dev). */
export async function runInContainer(instance, command, args = [], { onOutput = () => {}, env = {} } = {}) {
  const process = await instance.spawn(command, args, { env, terminal: { cols: 100, rows: 30 } });
  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        onOutput(chunk);
      },
    }),
  );
  const exitCode = await process.exit;
  return { exitCode };
}

/** `npm install` (or `npm ci` when a lockfile exists). */
export async function installInContainer(instance, { onOutput = () => {}, packages = [] } = {}) {
  const hasLock = await instance.fs
    .readFile('/package-lock.json', 'utf-8')
    .then(() => true)
    .catch(() => false);
  const args = hasLock && !packages.length ? ['ci'] : ['install', ...packages];
  onOutput(`\r\n$ npm ${args.join(' ')}\r\n`);
  return runInContainer(instance, 'npm', args, { onOutput });
}

/** Run the project's dev script; resolves once the server reports a URL. */
export async function startDevInContainer(instance, { script = 'dev', onOutput = () => {}, timeoutMs = 90_000 } = {}) {
  onOutput(`\r\n$ npm run ${script}\r\n`);
  let ready;
  const url = new Promise((resolve) => {
    ready = resolve;
  });
  const stop = instance.on('server-ready', (_port, serverUrl) => ready(serverUrl));
  const process = await instance.spawn('npm', ['run', script], { terminal: { cols: 100, rows: 30 } });
  process.output.pipeTo(
    new WritableStream({
      write(chunk) {
        onOutput(chunk);
      },
    }),
  );
  return {
    process,
    url: await Promise.race([url, new Promise((resolve) => setTimeout(() => resolve(''), timeoutMs))]).finally(() => {
      try {
        stop?.();
      } catch {
        /* the SDK's disposer is optional */
      }
    }),
  };
}
