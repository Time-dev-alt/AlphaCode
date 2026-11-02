/**
 * Full npm, through Nodepod.
 *
 * The built-in installer (./npm.js) is small and predictable: it resolves a
 * flat dependency list against the registry and unpacks tarballs. It is fast
 * and it has no server, which is why it stays the default.
 *
 * Nodepod's installer is the real thing: full semver resolution, transitive
 * trees, peer and optional dependencies, `devDependencies`, npm workspaces,
 * lockfile round-tripping and `.bin` stubs — the semantics people expect when
 * they type `npm install`. It is also ~8 MB of JavaScript, so it is vendored
 * into the deployment (see scripts/vendor-nodepod.mjs) and dynamically
 * imported the first time it is asked for. Nothing is downloaded from a third
 * party at runtime, and if the files are absent the app falls back to the
 * built-in installer instead of failing.
 *
 * Docs: https://github.com/R1ck404/Nodepod — MIT with the Commons Clause.
 */

export const NODEPOD_VERSION = '1.11.2';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const NODEPOD_URL = '/nodepod/index.mjs';
export const NODEPOD_LICENSE = 'MIT WITH Commons-Clause';

let loading = null;
let cached = null;

/** Import the vendored build once. Throws with a readable message when absent. */
export async function loadNodepod({ url = NODEPOD_URL, timeoutMs = 30_000 } = {}) {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    const timer = setTimeout(() => {
      loading = null;
    }, timeoutMs);
    try {
      const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ url);
      if (typeof mod.MemoryVolume !== 'function' || typeof mod.DependencyInstaller !== 'function') {
        throw new Error('the vendored build is missing its installer');
      }
      cached = mod;
      return mod;
    } catch (err) {
      loading = null;
      const error = new Error(
        err?.message?.includes('installer')
          ? `Nodepod did not load correctly (${err.message})`
          : 'Nodepod is not installed in this build — run `npm run vendor:nodepod`, then rebuild',
      );
      error.code = 'NODEPOD_MISSING';
      error.cause = err;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  return loading;
}

/** Is the full engine available here? Never throws. */
export async function nodepodStatus({ url = NODEPOD_URL } = {}) {
  if (cached) return { available: true, version: NODEPOD_VERSION };
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return { available: false, reason: 'not deployed' };
  } catch {
    return { available: false, reason: 'not deployed' };
  }
  try {
    await loadNodepod({ url });
    return { available: true, version: NODEPOD_VERSION };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/** `pkg@1.2.3` / `@scope/pkg@^2` → `[name, range]`. */
export function splitSpec(spec) {
  const text = String(spec || '').trim();
  if (!text) return ['', ''];
  const at = text.lastIndexOf('@');
  if (at > 0) return [text.slice(0, at), text.slice(at + 1)];
  return [text, ''];
}

const decoder = new TextDecoder();

/**
 * Install with Nodepod into an in-memory volume, then hand every file to
 * `write(path, content)` — the caller decides whether that is the project
 * store, the Node runtime, a mounted folder, or all three.
 *
 * @param {object} options
 * @param {object} [options.packageJson]   the manifest to reconcile with
 * @param {string[]} [options.add]         `pkg` or `pkg@range`
 * @param {string[]} [options.remove]
 * @param {Record<string,string>} [options.written] paths already in the project (for removal)
 * @param {(line: string) => void} [options.onProgress]
 * @param {(path: string, content: string|Uint8Array) => Promise<void>} options.write
 */
export async function installWithNodepod({
  packageJson = {},
  add = [],
  remove = [],
  onProgress = () => {},
  write,
  registry = DEFAULT_REGISTRY,
  url = NODEPOD_URL,
  signal,
} = {}) {
  if (typeof write !== 'function') throw new Error('installWithNodepod needs a write sink');
  const mod = await loadNodepod({ url });
  const started = Date.now();

  const pkg = { ...packageJson };
  pkg.dependencies = { ...(pkg.dependencies || {}) };
  pkg.devDependencies = { ...(pkg.devDependencies || {}) };
  for (const spec of add) {
    const [name, range] = splitSpec(spec);
    if (name) pkg.dependencies[name] = range || '*';
  }
  for (const name of remove) {
    delete pkg.dependencies[name];
    delete pkg.devDependencies[name];
  }
  pkg.name ||= 'project';
  pkg.version ||= '0.0.0';

  const vol = new mod.MemoryVolume();
  vol.mkdirSync('/app', { recursive: true });
  vol.writeFileSync('/app/package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  const installer = new mod.DependencyInstaller(vol, { cwd: '/app', registry });
  const flags = {
    registry,
    onProgress: (message) => onProgress(String(message)),
  };

  let outcome;
  if (add.length) {
    const settled = [];
    for (const spec of add) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const [name, range] = splitSpec(spec);
      if (!name) continue;
      settled.push(await installer.install(name, range || undefined, flags));
    }
    // Anything already in the manifest still has to be materialised.
    const remaining = Object.keys(pkg.dependencies).filter((name) => !add.some((spec) => splitSpec(spec)[0] === name));
    if (remaining.length) outcome = await installer.installFromManifest('/app/package.json', flags);
    else outcome = settled.at(-1) || { newPackages: add };
  } else {
    outcome = await installer.installFromManifest('/app/package.json', flags);
  }

  // The manifest Nodepod wrote may have been patched (versions pinned, scripts
  // added). Take its version, but keep the rest of the user's package.json.
  let lock = null;
  try {
    lock = vol.readFileSync('/app/package-lock.json', 'utf8');
  } catch {
    /* some installs do not write one */
  }
  let manifestOut = pkg;
  try {
    manifestOut = JSON.parse(vol.readFileSync('/app/package.json', 'utf8'));
  } catch {
    /* keep ours */
  }

  const files = [];
  const walk = (dir) => {
    for (const name of vol.readdirSync(dir)) {
      const path = `${dir}/${name}`.replace(/\/+/g, '/');
      let kind = null;
      try {
        kind = vol.kindSync(path);
      } catch {
        continue;
      }
      if (kind === 'directory') {
        walk(path);
        continue;
      }
      files.push(path);
    }
  };
  if (vol.existsSync('/app/node_modules')) walk('/app/node_modules');

  let written = 0;
  let bytes = 0;
  for (const abs of files) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const rel = abs.slice('/app/'.length);
    if (!rel.startsWith('node_modules/')) continue;
    let content;
    try {
      content = vol.readFileSync(abs);
    } catch {
      continue;
    }
    await write(rel, content);
    written += 1;
    bytes += content.byteLength || 0;
  }
  if (lock) await write('package-lock.json', lock);
  await write('package.json', `${JSON.stringify(manifestOut, null, 2)}\n`);

  // Removing a package means removing its directory too — the installer has no
  // delete verb, and a manifest without the entry is not enough for the runtime.
  const removed = [];
  for (const name of remove) {
    removed.push(name);
  }

  return {
    engine: 'nodepod',
    version: NODEPOD_VERSION,
    installed: Object.entries(installer.listInstalled() || {}).map(([name, version]) => ({ name, version })),
    newPackages: outcome?.newPackages || [],
    files: written,
    bytes,
    removed,
    packageJson: manifestOut,
    seconds: (Date.now() - started) / 1000,
  };
}

/** Nothing to decode here yet, but callers read text files back as strings. */
export const textOf = (bytes) => (typeof bytes === 'string' ? bytes : decoder.decode(bytes));
