#!/usr/bin/env node
/**
 * Fetch Nodepod's published build into `public/nodepod/`.
 *
 * It is deliberately not committed: it is ~8 MB of someone else's code, and the
 * app works without it (the built-in npm installer takes over). Running this
 * once before `npm run build` is what turns on the full installer.
 *
 *   npm run vendor:nodepod
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'nodepod');
const PACKAGE = '@r1ck404/nodepod';
const VERSION = process.argv.includes('--latest') ? null : process.env.NODEPOD_VERSION || '1.11.2';
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmjs.org';

const say = (line) => process.stdout.write(`[vendor:nodepod] ${line}\n`);

async function packument(name) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
  return res.json();
}

/** Minimal ustar reader — the same subset npm publishes. */
function untar(buffer) {
  const bytes = new Uint8Array(buffer);
  const files = [];
  let offset = 0;
  const text = (start, length) => {
    let end = start;
    while (end < start + length && bytes[end] !== 0) end += 1;
    return Buffer.from(bytes.subarray(start, end)).toString('utf8');
  };
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = text(offset, 100);
    const prefix = text(offset + 345, 155);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(bytes[offset + 156] || 48);
    const filePath = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    if (type === '0' || type === '\0') {
      files.push({ path: filePath, data: bytes.subarray(offset, offset + size) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function main() {
  const meta = await packument(PACKAGE);
  const version = VERSION || meta['dist-tags']?.latest;
  const info = meta.versions?.[version];
  if (!info) throw new Error(`no version ${version} of ${PACKAGE}`);

  say(`downloading ${PACKAGE}@${version}`);
  const res = await fetch(info.dist.tarball);
  if (!res.ok) throw new Error(`tarball ${res.status}`);
  const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
  const entries = untar(tar);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    // Only the built ESM graph; sourcemaps are half the download.
    if (!entry.path.startsWith('package/dist/')) continue;
    if (entry.path.endsWith('.map') || entry.path.endsWith('.cjs')) continue;
    const rel = entry.path.slice('package/dist/'.length);
    const target = path.join(OUT, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    files += 1;
    bytes += entry.data.byteLength;
  }

  await writeFile(
    path.join(OUT, 'manifest.json'),
    `${JSON.stringify({ package: PACKAGE, version, license: info.license || null, files, bytes, vendoredAt: new Date().toISOString() }, null, 2)}\n`,
  );
  say(`${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB → public/nodepod`);
  say('now run `npm run build`');
}

main().catch((err) => {
  process.stderr.write(`[vendor:nodepod] ${err.message}\n`);
  process.exit(1);
});
