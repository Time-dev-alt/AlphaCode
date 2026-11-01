/**
 * `npm install`, in the browser.
 *
 * Three requests per install, not three hundred:
 *   1. POST /api/npm/resolve   → the whole dependency graph resolved at the edge
 *   2. GET  /api/npm/tar/…     → one tarball per package (cached at the edge + KV)
 *   3. write into node_modules
 *
 * If the edge is not deployed (any static host), the client resolves the graph
 * itself against registry.npmjs.org — same code path, just slower and with more
 * requests. Either way extraction happens in the tab with fflate.
 */
import { gunzipSync } from 'fflate';
import { maxSatisfying, resolveSpec } from '../semver.js';
import { toBytes, fromBytes } from './vfs.js';

const REGISTRY = 'https://registry.npmjs.org';
const CONCURRENCY = 6;

/* ------------------------------------------------------------------ tar --- */

/** Minimal ustar reader: regular files only, which is all npm ships. */
export function untar(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const files = [];
  let offset = 0;
  const readString = (start, length) => {
    let end = start;
    while (end < start + length && bytes[end] !== 0) end++;
    return fromBytes(bytes.subarray(start, end));
  };
  const readOctal = (start, length) => {
    const text = readString(start, length).trim();
    return text ? parseInt(text, 8) : 0;
  };
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readString(offset, 100);
    const prefix = readString(offset + 345, 155);
    const size = readOctal(offset + 124, 12);
    const type = String.fromCharCode(bytes[offset + 156] || 48);
    const path = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    if (type === '0' || type === '\0' || type === '' || type === '0') {
      files.push({ path, data: bytes.subarray(offset, offset + size) });
    } else if (type === 'x' || type === 'g') {
      // pax extended header: the next entry's real path may follow
      const meta = fromBytes(bytes.subarray(offset, offset + size));
      const match = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(`${meta}\n`);
      if (match && type === 'x') files.paxPath = match[1];
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

/* ----------------------------------------------------------- resolution --- */

const packumentCache = new Map();

async function fetchPackument(name, { edge, signal } = {}) {
  if (packumentCache.has(name)) return packumentCache.get(name);
  const urls = [];
  if (edge) urls.push(`${edge}/pkg/${name}`);
  urls.push(`${REGISTRY}/${name.replace('/', '%2f')}`);
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal,
        headers: url.includes('registry.npmjs.org') ? { Accept: 'application/vnd.npm.install-v1+json' } : {},
      });
      if (res.status === 404) throw new Error(`package '${name}' does not exist`);
      if (!res.ok) throw new Error(`registry ${res.status}`);
      const json = await res.json();
      packumentCache.set(name, json);
      return json;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`could not fetch ${name}`);
}

/** Client-side fallback when the edge resolver is unavailable. */
export async function resolveLocal(dependencies, { edge, onLog = () => {}, signal } = {}) {
  const queue = Object.entries(dependencies).map(([name, range]) => ({ name, range: String(range) }));
  const packages = {};
  const warnings = [];
  const seen = new Set();
  let guard = 0;
  while (queue.length && guard++ < 400) {
    const batch = queue.splice(0, CONCURRENCY);
    await Promise.all(
      batch.map(async ({ name, range }) => {
        const key = `${name}@${range}`;
        if (seen.has(key)) return;
        seen.add(key);
        let packument;
        try {
          packument = await fetchPackument(name, { edge, signal });
        } catch (err) {
          warnings.push(`${name}: ${err.message}`);
          return;
        }
        const spec = resolveSpec(range, packument['dist-tags'] || {});
        const version = packument.versions?.[spec.range]
          ? spec.range
          : maxSatisfying(Object.keys(packument.versions || {}), spec.range);
        if (!version) {
          warnings.push(`${name}@${range}: no matching version`);
          return;
        }
        const manifest = packument.versions[version];
        const id = `${name}@${version}`;
        if (packages[id]) return;
        packages[id] = {
          name,
          version,
          resolved: manifest.dist?.tarball || `${REGISTRY}/${name}/-/${name.split('/').pop()}-${version}.tgz`,
          integrity: manifest.dist?.integrity || null,
          dependencies: manifest.dependencies || {},
          bin: manifest.bin || null,
        };
        onLog(`· ${name}@${version}`);
        for (const [dep, depRange] of Object.entries(manifest.dependencies || {})) {
          if (!packages[`${dep}@${depRange}`]) queue.push({ name: dep, range: depRange });
        }
      }),
    );
  }
  return { packages, warnings, order: Object.keys(packages) };
}

/** Ask the edge for a cached plan; fall back to local resolution. */
export async function resolvePlan(dependencies, { edge = '/api/npm', onLog = () => {}, signal } = {}) {
  if (edge) {
    try {
      const res = await fetch(`${edge}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dependencies }),
        signal,
      });
      if (res.ok) {
        const plan = await res.json();
        if (plan && plan.packages) {
          onLog(`resolved ${plan.order?.length ?? Object.keys(plan.packages).length} packages at the edge${plan.cached ? ' (cached plan)' : ''}`);
          return { ...plan, source: 'edge' };
        }
      }
    } catch {
      /* static host → local resolver */
    }
  }
  onLog('edge resolver unavailable — resolving against the registry directly');
  const plan = await resolveLocal(dependencies, { edge: null, onLog, signal });
  return { ...plan, source: 'client' };
}

/* -------------------------------------------------------------- install --- */

async function fetchTarball(pkg, { edge, signal }) {
  const urls = [];
  const registryPath = pkg.resolved.replace(/^https?:\/\/registry\.npmjs\.org\//, '');
  if (edge) urls.push(`${edge}/tar/${registryPath}`);
  urls.push(pkg.resolved);
  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`tarball ${res.status}`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      return gunzipSync(buffer);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`could not download ${pkg.resolved}`);
}

const stripPackagePrefix = (path) => path.replace(/^[^/]+\//, '');

/**
 * Install dependencies into `node_modules` inside the runtime filesystem.
 * @param {object} options
 * @param {{ packageJson?: object, add?: string[], remove?: string[], edge?: string, signal?: AbortSignal, onLog?: Function, onProgress?: Function }} options
 * @returns {Promise<{installed: object[], warnings: string[], lock: object, packageJson: object}>}
 */
export async function install({ packageJson = {}, add = [], remove = [], edge = '/api/npm', signal, onLog = () => {}, onProgress = () => {}, dependencies = null } = {}) {
  const pkg = { ...packageJson };
  pkg.dependencies = { ...(pkg.dependencies || {}) };

  for (const spec of add) {
    const [name, version] = splitSpec(spec);
    pkg.dependencies[name] = version || 'latest';
  }
  for (const name of remove) delete pkg.dependencies[name];

  const wanted = dependencies || pkg.dependencies;
  const names = Object.keys(wanted);
  if (!names.length) return { installed: [], warnings: [], lock: { name: pkg.name, lockfileVersion: 3, packages: {} }, packageJson: pkg };

  onLog(`resolving ${names.length} direct ${names.length === 1 ? 'dependency' : 'dependencies'}…`);
  const plan = await resolvePlan(wanted, { edge, onLog, signal });

  const entries = Object.entries(plan.packages || {});
  const installed = [];
  let done = 0;
  const queue = [...entries];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const [id, info] = queue.shift();
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      try {
        const tar = await fetchTarball(info, { edge, signal });
        const files = untar(tar);
        const base = `node_modules/${info.name}`;
        let count = 0;
        let bytes = 0;
        for (const file of files) {
          if (!file.path || file.path.endsWith('/')) continue;
          const rel = stripPackagePrefix(file.path);
          if (!rel || rel.startsWith('..')) continue;
          const target = `${base}/${rel}`;
          runtimeWrite?.(target, file.data);
          count++;
          bytes += file.data.byteLength;
        }
        installed.push({ id, name: info.name, version: info.version, files: count, bytes });
      } catch (err) {
        plan.warnings = plan.warnings || [];
        plan.warnings.push(`${id}: ${err.message}`);
      }
      done++;
      onProgress({ done, total: entries.length, id });
      // keep the tab responsive during large installs
      await new Promise((r) => setTimeout(r, 0));
    }
  });

  // `runtimeWrite` is injected below to avoid a circular import with the runtime.
  await Promise.all(workers);
  void done;

  const lock = {
    name: pkg.name || 'project',
    version: pkg.version || '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
      ...Object.fromEntries(entries.map(([id, info]) => [`node_modules/${id.split('@').slice(0, -1).join('@') || id}`, { version: info.version, resolved: info.resolved, integrity: info.integrity }])),
    },
  };
  return { installed, warnings: plan.warnings || [], lock, packageJson: pkg, source: plan.source };
}

let runtimeWrite = null;
/** Bind the filesystem writer used during extraction (set by the shell/runtime glue). */
export function bindRuntimeWriter(fn) {
  runtimeWrite = fn;
}

const splitSpec = (spec) => {
  const text = String(spec).trim();
  const at = text.lastIndexOf('@');
  if (at > 0) return [text.slice(0, at), text.slice(at + 1)];
  return [text, ''];
};

/** Format a byte count for the terminal. */
export const humanBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export { toBytes, fromBytes };
