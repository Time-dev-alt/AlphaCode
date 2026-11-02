/**
 * Keep a WebContainer's `node_modules` across page loads.
 *
 * A WebContainer is memory, not storage: close the tab and the 60-second
 * `npm install` you just paid for is gone. OPFS is the one place in a browser
 * that survives a reload and is reachable without the main thread, so the
 * installed tree is snapshotted there, keyed by a fingerprint of the manifest.
 *
 * Deliberately conservative:
 *   • only the manifest decides validity — change `package.json` and the cache
 *     misses, which is correct and cheap;
 *   • the snapshot is capped (files and bytes). A cache that silently eats a
 *     user's storage quota, or takes longer to restore than to reinstall, is
 *     worse than no cache;
 *   • every function is total: no OPFS, no quota, corrupt entry → `null`, and
 *     the caller installs normally.
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export const CACHE_VERSION = 1;
export const CACHE_DIR = 'alphacode-cache';
export const DEFAULT_MAX_FILES = 4000;
export const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

/** Files that make a dependency install unique. */
const MANIFESTS = ['package.json', 'npm-shrinkwrap.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

/** FNV-1a over the manifest contents — small, stable, no crypto round trip. */
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Fingerprint a project's dependency state.
 * Returns '' when there is no manifest to install from — nothing to cache.
 */
export function projectFingerprint(files = {}) {
  const parts = MANIFESTS.map((name) => (typeof files[name] === 'string' ? `${name}\n${files[name]}` : '')).filter(Boolean);
  if (!parts.length) return '';
  return `${CACHE_VERSION}-${hashText(parts.join('\n\n'))}`;
}

/** Would this snapshot be worth writing? */
export function isCacheable({ fileCount = 0, bytes = 0, maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!fileCount) return false;
  return fileCount <= maxFiles && bytes <= maxBytes;
}

/**
 * Read `/node_modules` (and the manifest) out of a mounted project directory.
 *
 * @returns {Promise<{files: Record<string,string>, bytes:number, truncated:boolean}>}
 */
export async function snapshotModules(instance, { dir = '/node_modules', maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const files = {};
  let bytes = 0;
  let truncated = false;

  const walk = async (abs, depth) => {
    if (truncated || depth > 12) return;
    let entries;
    try {
      entries = await instance.fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Object.keys(files).length >= maxFiles || bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const child = `${abs.replace(/\/$/, '')}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
        continue;
      }
      try {
        // Binary files are skipped: npm packages ship plenty of wasm and fonts,
        // and a text-only snapshot is what the mount API can write back cheaply.
        const text = await instance.fs.readFile(child, 'utf-8');
        if (text.includes('\u0000')) continue;
        bytes += text.length;
        if (bytes > maxBytes) {
          truncated = true;
          return;
        }
        files[child.replace(/^\//, '')] = text;
      } catch {
        /* unreadable entry — the package still works without it in the cache */
      }
    }
  };

  await walk(dir, 0);
  return { files, bytes, truncated };
}

/* ----------------------------------------------------------------- OPFS -- */

async function cacheDirectory({ create = false } = {}) {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CACHE_DIR, { create });
    return dir;
  } catch {
    return null;
  }
}

/** Write a snapshot. Silently a no-op when OPFS is unavailable or full. */
export async function saveContainerCache(fingerprint, snapshot) {
  if (!fingerprint) return { saved: false, reason: 'no manifest' };
  const { files = {}, bytes = 0 } = snapshot || {};
  const fileCount = Object.keys(files).length;
  if (!isCacheable({ fileCount, bytes })) return { saved: false, reason: `too large to cache (${fileCount} files, ${bytes} bytes)` };

  const dir = await cacheDirectory({ create: true });
  if (!dir) return { saved: false, reason: 'no storage here' };
  try {
    const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])), { level: 1 });
    const handle = await dir.getFileHandle(`${fingerprint}.zip`, { create: true });
    const stream = await handle.createWritable();
    await stream.write(zipped);
    await stream.close();
    return { saved: true, files: fileCount, bytes: zipped.byteLength };
  } catch (err) {
    return { saved: false, reason: String(err?.message || err) };
  }
}

/** Read a snapshot back, or `null` when there is nothing usable. */
export async function loadContainerCache(fingerprint) {
  if (!fingerprint) return null;
  const dir = await cacheDirectory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(`${fingerprint}.zip`);
    const buffer = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    const entries = unzipSync(buffer);
    const files = {};
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/')) continue;
      files[path] = strFromU8(data);
    }
    if (!Object.keys(files).length) return null;
    return { files, bytes: buffer.byteLength };
  } catch {
    return null;
  }
}

/** Drop every cached install (Settings → Runtimes → “forget cached installs”). */
export async function clearContainerCaches() {
  const dir = await cacheDirectory();
  if (!dir) return 0;
  let removed = 0;
  try {
    for await (const [name] of dir.entries()) {
      if (!name.endsWith('.zip')) continue;
      await dir.removeEntry(name).catch(() => {});
      removed += 1;
    }
  } catch {
    /* an unreadable cache directory is the same as an empty one */
  }
  return removed;
}

/** How much space the cache is using, for the settings row. */
export async function containerCacheSize() {
  const dir = await cacheDirectory();
  if (!dir) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  try {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind !== 'file' || !name.endsWith('.zip')) continue;
      const file = await entry.getFile();
      files += 1;
      bytes += file.size;
    }
  } catch {
    /* ignore */
  }
  return { files, bytes };
}
