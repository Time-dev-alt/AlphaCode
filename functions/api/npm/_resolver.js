/**
 * npm dependency resolution, at the edge.
 *
 * This is the part that makes browser-side `npm install` feel instant for
 * everybody: the first visitor resolves a dependency set, the result is written
 * to KV, and every later visitor with the same dependencies gets a flat plan
 * (versions + tarball URLs + checksums) in one round trip instead of hundreds.
 *
 * The resolver is deliberately small and boring: npm-flat hoisting, no
 * `overrides`, no `peerDependencies` solving (peers are recorded and warned
 * about). That covers the pure-JS packages a browser can actually run.
 */
import { maxSatisfying, resolveSpec, sortDesc, parse } from '../../../web/engine/semver.js';

export const REGISTRY = 'https://registry.npmjs.org';
const MAX_PACKAGES = 300;
const CONCURRENCY = 8;

/** Fields the browser runtime actually reads. Everything else is dropped. */
const KEEP = [
  'name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies',
  'peerDependenciesMeta', 'bin', 'main', 'module', 'browser', 'type', 'license',
  'exports', 'engines', 'os', 'cpu', 'deprecated',
];

export function slimPackument(raw) {
  if (!raw || !raw.versions) return null;
  const versions = {};
  for (const [version, manifest] of Object.entries(raw.versions)) {
    const entry = {};
    for (const key of KEEP) if (manifest[key] !== undefined) entry[key] = manifest[key];
    if (!entry.dist && manifest.dist) entry.dist = manifest.dist;
    if (manifest.dist) entry.dist = { tarball: manifest.dist.tarball, integrity: manifest.dist.integrity, shasum: manifest.dist.shasum };
    versions[version] = entry;
  }
  return {
    name: raw.name,
    'dist-tags': raw['dist-tags'] || {},
    modified: raw.modified || raw.time?.modified || null,
    versions,
  };
}

/** Fetch an abbreviated packument (the registry's install-optimised format). */
export async function fetchPackument(name, { fetchImpl = fetch, registry = REGISTRY, cache } = {}) {
  const url = `${registry}/${name.replace('/', '%2f')}`;
  const cacheKey = new Request(`${url}?abbrev=1`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  const res = await fetchImpl(url, {
    headers: {
      // 5–10× smaller than the full document, and it is what npm itself uses.
      Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
      'User-Agent': 'alphacode-npm-proxy/1 (+https://github.com/Time-dev-alt/Nex)',
    },
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  if (res.status === 404) throw new Error(`package '${name}' does not exist on npm`);
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${name}`);
  const json = await res.json();
  const slim = slimPackument(json);
  if (cache && slim) {
    // Fire-and-forget: the client should not wait on a cache write.
    cache.put(cacheKey, new Response(JSON.stringify(slim), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' } })).catch(() => {});
  }
  return slim;
}

function pick(packument, range) {
  const tags = packument['dist-tags'] || {};
  const spec = resolveSpec(range, tags);
  const versions = Object.keys(packument.versions || {});
  if (tags[spec.range]) return { version: tags[spec.range], alias: spec.alias };
  if (packument.versions?.[spec.range]) return { version: spec.range, alias: spec.alias };
  const best = maxSatisfying(versions, spec.range);
  return { version: best, alias: spec.alias };
}

const isBrowserOk = (manifest) => {
  if (!manifest) return false;
  const os = manifest.os && !manifest.os.includes('!');
  const cpu = manifest.cpu && !manifest.cpu.includes('!');
  if (os || cpu) return false; // platform-specific = native = not runnable in a tab
  return true;
};

/**
 * Resolve a dependency map into a flat, hoisted plan.
 * @returns {{packages: object, order: string[], warnings: string[], cached: boolean}}
 */
export async function resolveGraph(dependencies, { fetchImpl = fetch, cache, registry = REGISTRY, maxPackages = MAX_PACKAGES } = {}) {
  const wanted = new Map(); // name -> range (highest wins)
  const queue = Object.entries(dependencies || {}).map(([name, range]) => ({ name, range: String(range || '*'), from: 'root' }));
  const chosen = new Map(); // `${name}@${version}` -> entry
  const byName = new Map(); // name -> version (flat hoisting)
  const warnings = [];
  const packuments = new Map();

  const loadPackument = async (name) => {
    if (packuments.has(name)) return packuments.get(name);
    const p = await fetchPackument(name, { fetchImpl, registry, cache });
    packuments.set(name, p);
    return p;
  };

  const workers = [];
  const take = async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      const { name, range } = job;
      const prev = wanted.get(name);
      // A package is resolved once per install (npm-flat-ish). `*` never
      // overrides a concrete range, and a second, incompatible range is a
      // warning rather than a second copy — the browser runtime has one copy.
      if (prev !== undefined) {
        if (prev !== range && prev !== '*' && !(await compatible(prev, range))) {
          warnings.push(`mixed versions for ${name}: ${prev} and ${range} — using ${byName.get(name)}`);
        }
        continue;
      }
      wanted.set(name, range);
      let packument;
      try {
        packument = await loadPackument(name);
      } catch (err) {
        warnings.push(`${name}: ${err.message}`);
        continue;
      }
      const { version, alias } = pick(packument, range);
      if (!version) {
        warnings.push(`${name}@${range}: no matching version`);
        continue;
      }
      const target = alias || name;
      const manifest = packument.versions[version];
      if (!isBrowserOk(manifest)) {
        warnings.push(`${target}@${version} is platform-specific (native) and cannot run in the browser`);
        continue;
      }
      const key = `${target}@${version}`;
      if (!byName.has(target)) byName.set(target, version);
      if (chosen.has(key)) continue;
      if (chosen.size >= maxPackages) {
        warnings.push(`dependency graph truncated at ${maxPackages} packages`);
        return;
      }
      const spec = resolveSpec(range, packument['dist-tags'] || {});
      chosen.set(key, {
        name: target,
        alias: spec.alias || undefined,
        version,
        resolved: manifest.dist?.tarball || `${registry}/${target}/-/${target.split('/').pop()}-${version}.tgz`,
        integrity: manifest.dist?.integrity || null,
        dependencies: manifest.dependencies || {},
        optionalDependencies: manifest.optionalDependencies || {},
        peerDependencies: manifest.peerDependencies || {},
        bin: manifest.bin || null,
        main: manifest.main || null,
        module: manifest.module || null,
        type: manifest.type || 'commonjs',
        exports: manifest.exports || null,
        license: manifest.license || null,
      });
      for (const [dep, depRange] of Object.entries(manifest.dependencies || {})) {
        if (dep === target) continue;
        queue.push({ name: dep, range: String(depRange), from: key });
      }
    }
  };

  for (let i = 0; i < CONCURRENCY; i++) workers.push(take());
  await Promise.all(workers);

  const order = [...chosen.keys()].sort((a, b) => {
    const [an, av] = splitKey(a);
    const [bn, bv] = splitKey(b);
    if (an === bn) return parse(bv) && parse(av) ? 0 : 0;
    return an.localeCompare(bn);
  });
  return {
    packages: Object.fromEntries([...chosen].map(([k, v]) => [k, v])),
    order,
    warnings,
    resolvedAt: Date.now(),
  };
}

function splitKey(key) {
  const at = key.lastIndexOf('@');
  return [key.slice(0, at), key.slice(at + 1)];
}

async function compatible(a, b) {
  return a === b;
}

/** Stable key for the KV/edge cache: same deps in, same plan out. */
export async function planKey(dependencies) {
  const canonical = Object.entries(dependencies || {})
    .map(([k, v]) => `${k}@${v}`)
    .sort()
    .join('\n');
  const bytes = new TextEncoder().encode(canonical);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  }
  let hash = 0;
  for (const b of bytes) hash = (hash * 31 + b) >>> 0;
  return `h${hash.toString(16)}`;
}

/** Every version of a package that satisfies a range — used by the UI picker. */
export function versionsFor(packument, range) {
  return sortDesc(Object.keys(packument?.versions || {})).filter((v) => maxSatisfying([v], range) === v);
}
