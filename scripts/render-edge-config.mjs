#!/usr/bin/env node
/**
 * Fill the @@ALPHACODE_ORIGIN@@ placeholder in deploy/netlify.toml and
 * deploy/vercel.json with the URL of your Node runtime.
 *
 *   node scripts/render-edge-config.mjs --origin=https://runtime.example.com [--out=dist/edge]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : '';
};

const origin = (arg('origin') || process.env.ALPHACODE_ORIGIN || '').replace(/\/+$/, '');
if (!/^https:\/\/[^\s]+$/.test(origin)) {
  console.error('usage: node scripts/render-edge-config.mjs --origin=https://runtime.example.com');
  process.exit(1);
}

const outDir = path.resolve(ROOT, arg('out') || 'dist/edge');
await fsp.mkdir(outDir, { recursive: true });

for (const file of ['netlify.toml', 'vercel.json']) {
  const src = path.join(ROOT, 'deploy', file);
  if (!fs.existsSync(src)) continue;
  const body = (await fsp.readFile(src, 'utf8')).split('@@ALPHACODE_ORIGIN@@').join(origin);
  await fsp.writeFile(path.join(outDir, file), body);
  console.log(`✓ ${file} → ${path.relative(ROOT, path.join(outDir, file))}`);
}
console.log(`\nUse with: netlify deploy --prod --dir=dist/public   (from a dir containing netlify.toml)`);
