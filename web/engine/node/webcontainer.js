/**
 * WebContainers — real Node.js and npm, in the tab, from StackBlitz.
 *
 * AlphaCode already ships two Node paths:
 *   • the built-in runtime (`engine/node/`) — pure-JS packages, instant, no
 *     download, but no native addons and no real process model;
 *   • Nodepod — a fuller npm resolver, still our own runtime underneath.
 *
 * Neither is `node` itself. WebContainers *is*: a WebAssembly port of Node with
 * a real process table and npm, so a Vite/Next/Express project behaves the way
 * it does on a laptop — including `npm run dev` serving a live URL.
 *
 * ## Why this file is careful
 *
 * `WebContainer.boot()` does not just run code: it embeds a hidden iframe from
 * `stackblitz.com/headless` that must be allowed to be *cross-origin isolated*.
 * That gives four hard requirements, and a boot that fails on any of them fails
 * with a stack trace from inside the SDK rather than a sentence a person can act
 * on. So the requirements are checked first, reported individually, and the
 * checks are structured to be testable outside a browser:
 *
 *   1. the SDK itself (`@webcontainer/api`, bundled — not fetched from a CDN);
 *   2. `SharedArrayBuffer` (needs a secure context);
 *   3. `crossOriginIsolated` — i.e. the document was served with
 *      `Cross-Origin-Opener-Policy: same-origin` **and** a
 *      `Cross-Origin-Embedder-Policy`. `functions/_middleware.js` sends those
 *      for a visitor who turned the sandbox on, because tightening them for
 *      everyone would break OAuth popups;
 *   4. a Chromium-family browser or Firefox 121+; Safari cannot boot it, and an
 *      embedded frame only works when the *parent* grants
 *      `allow="cross-origin-isolated"`.
 *
 * Nothing here touches the project files until `boot()` is called, and every
 * file written inside the container can be mirrored back through `onFileWritten`.
 */

/** Pinned: a WebContainers major can change the boot protocol. */
export const WEBCONTAINER_VERSION = '1.5.1';

/** The cookie `functions/_middleware.js` reads to decide whether to isolate. */
export const ISOLATION_COOKIE = 'nex_wc';

export const webcontainerSupported = () => typeof window !== 'undefined' && Boolean(window.crossOriginIsolated) && typeof SharedArrayBuffer === 'function';

/** The absolute minimum the SDK needs, without looking at headers. */
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

/* ------------------------------------------------------------- preflight -- */

const SAFARI_ONLY = (ua) => /^((?!chrome|chromium|crios|edg|android).)*safari/i.test(ua);

/**
 * Check every requirement and say which ones failed.
 *
 * @param {object} [options]
 * @param {Window|object} [options.win]   injected for tests
 * @param {Function} [options.fetchImpl]  injected for tests
 * @returns {Promise<{ok:boolean, checks:Array, coep:string, isolated:boolean, framed:boolean, blockers:Array, hint:string}>}
 */
export async function inspectSandbox({ win = typeof window === 'undefined' ? null : window, fetchImpl = (...a) => fetch(...a) } = {}) {
  const checks = [];
  const add = (id, label, ok, detail) => {
    checks.push({ id, label, ok, detail });
    return ok;
  };

  if (!win) {
    add('browser', 'A browser', false, 'this code is running outside a browser');
    return finish(checks, { coep: '', isolated: false, framed: false });
  }

  const ua = String(win.navigator?.userAgent || '');
  const secure = win.isSecureContext !== false; // undefined in jsdom counts as unknown-but-fine
  const isolated = Boolean(win.crossOriginIsolated);
  const framed = Boolean(win.top && win.self !== win.top);
  const sab = typeof win.SharedArrayBuffer === 'function' || typeof SharedArrayBuffer === 'function';
  const safari = SAFARI_ONLY(ua);
  const chromiumOrFirefox = !safari;

  add('sdk', 'WebContainers SDK', true, `@webcontainer/api ${WEBCONTAINER_VERSION}, bundled with the app`);
  add('secure', 'HTTPS (secure context)', secure, secure ? 'the page is trusted' : 'WebContainers needs https:// or localhost');
  add('sab', 'SharedArrayBuffer', sab, sab ? 'available' : 'this browser does not expose SharedArrayBuffer');
  add('browser', 'Supported browser', chromiumOrFirefox, safari ? 'Safari cannot boot WebContainers yet — use Chrome, Edge or Firefox 121+' : 'Chromium or Firefox');

  // The headers are the part people get wrong, and `crossOriginIsolated` alone
  // cannot tell you *which* one is missing — so ask the server.
  let coep = '';
  let coop = '';
  try {
    const res = await fetchImpl(win.location.href, { method: 'HEAD', cache: 'no-store' });
    coep = String(res.headers.get('cross-origin-embedder-policy') || '').toLowerCase();
    coop = String(res.headers.get('cross-origin-opener-policy') || '').toLowerCase();
  } catch {
    /* the probe is advisory: the flags below are the source of truth */
  }
  add('coop', 'Cross-Origin-Opener-Policy', coop === 'same-origin' || isolated, coop || (isolated ? 'not reported, but the page is isolated' : 'missing'));
  add('coep', 'Cross-Origin-Embedder-Policy', coep === 'credentialless' || coep === 'require-corp' || isolated, coep || (isolated ? 'not reported, but the page is isolated' : 'missing'));
  add('isolated', 'Cross-origin isolated', isolated, isolated ? 'the page is isolated' : 'the sandbox iframe will be refused without it');
  if (framed) {
    add(
      'frame',
      'Own tab',
      isolated,
      isolated ? 'the surrounding page granted cross-origin isolation' : 'this tab is embedded in a frame that has not granted “cross-origin-isolated” — open AlphaCode in its own tab',
    );
  }

  return finish(checks, { coep: coep === 'credentialless' ? 'credentialless' : coep === 'require-corp' ? 'require-corp' : '', isolated, framed });
}

function finish(checks, extra) {
  const blockers = checks.filter((check) => !check.ok);
  const wantsOwnTab = blockers.some((check) => check.id === 'frame' || check.id === 'isolated' || check.id === 'coop' || check.id === 'coep');
  return {
    ...extra,
    checks,
    blockers,
    ok: blockers.length === 0,
    hint: !blockers.length
      ? 'Everything WebContainers needs is present.'
      : wantsOwnTab
        ? 'Turn on “Node sandbox” in Settings → Runtimes, reload, and open AlphaCode in its own browser tab.'
        : `WebContainers needs: ${blockers.map((b) => b.label.toLowerCase()).join(', ')}.`,
  };
}

/** Turn the sandbox switch on/off for this browser (the headers follow a reload). */
export function setIsolationCookie(on, doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return;
  doc.cookie = on ? `${ISOLATION_COOKIE}=1; path=/; max-age=31536000; samesite=lax` : `${ISOLATION_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/* ---------------------------------------------------------------- mount -- */

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

/** Read back every text file under a directory, as a flat map. */
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

/* ----------------------------------------------------------------- boot -- */

export class SandboxUnavailable extends Error {
  constructor(message, { hint = '', blockers = [] } = {}) {
    super(message);
    this.name = 'SandboxUnavailable';
    this.hint = hint;
    this.blockers = blockers;
  }
}

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
 * @param {object} [options.inspect]  pre-computed `inspectSandbox()` result
 * @returns {Promise<object>} the WebContainer instance
 */
export async function bootWebContainer({ files = {}, onOutput = () => {}, onServerReady = () => {}, onFileWritten = null, inspect = null } = {}) {
  const report = inspect || (await inspectSandbox());
  if (!report.ok) {
    throw new SandboxUnavailable(`WebContainers cannot start: ${report.blockers.map((b) => b.label).join(', ')}.`, {
      hint: report.hint,
      blockers: report.blockers,
    });
  }

  if (!booting) {
    booting = (async () => {
      // Bundled, not fetched from a CDN: a CDN import is one more origin that a
      // CSP, an extension or a corporate proxy can block, and it is slower.
      const { WebContainer } = await import('@webcontainer/api');
      // The `coep` option must match the header the page was served with, or the
      // hidden iframe and the parent disagree about isolation.
      const instance = await WebContainer.boot(report.coep ? { coep: report.coep } : {});
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
      onOutput(`WebContainer ${WEBCONTAINER_VERSION} ready\n`);
      return instance;
    })().catch((err) => {
      booting = null;
      container = null;
      throw err;
    });
  }
  const instance = await booting;
  if (Object.keys(files).length) await instance.mount(toFileTree(files));
  return instance;
}

/** Stop the container and free the tab's memory. */
export async function stopWebContainer() {
  if (!container) return false;
  try {
    container.teardown?.();
  } finally {
    container = null;
    booting = null;
  }
  return true;
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
    url: await Promise.race([url, new Promise((resolve) => setTimeout(() => resolve(''), timeoutMs).unref?.())]).finally(() => {
      try {
        stop?.();
      } catch {
        /* the SDK's disposer is optional */
      }
    }),
  };
}
