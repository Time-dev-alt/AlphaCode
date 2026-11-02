#!/usr/bin/env node
/**
 * Build the **client-side** AlphaCode for Cloudflare Pages.
 *
 *   node scripts/build-pages.mjs [--obfuscate] [--no-minify]
 *
 * Output → dist/
 *   index.html            app shell (hashed assets + SRI + import map)
 *   assets/app.<hash>.js  the whole app: harness, filesystem, shell, sqlite, deploy
 *   assets/app.<hash>.css
 *   assets/sql-wasm.wasm  SQLite engine (vendored, no CDN)
 *   assets/vendor/        Pyodide loader is CDN-only (optional runtime)
 *   _headers, _redirects  Pages configuration
 *   functions/            Pages Functions (GitHub OAuth)
 *   integrity.json        SRI manifest
 *
 * Nothing here is a server: the output is static files plus two OAuth functions.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const args = new Set(process.argv.slice(2));
const OBFUSCATE = args.has('--obfuscate');
const MINIFY = !args.has('--no-minify');

const log = (...a) => console.log('[build:pages]', ...a);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
const sri = (buf) => `sha384-${crypto.createHash('sha384').update(buf).digest('base64')}`;

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await fsp.stat(full)).size;
  }
  return total;
}

async function bundle(entry = path.join(ROOT, 'web', 'app', 'main.js'), extraDefine = {}) {
  const esbuild = await import('esbuild');
  const outdir = path.join(DIST, 'assets');
  await fsp.mkdir(outdir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    platform: 'browser',
    splitting: false,
    minify: MINIFY,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    define: {
      'process.env.NODE_ENV': '"production"',
      // The bundle is served from /assets/, so the wasm sits next to it. Defining
      // import.meta.url also keeps the output runnable as a classic script (tests).
      '__ASSET_BASE__': '"/assets/"',
      ...extraDefine,
    },
    loader: { '.css': 'css' },
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

async function obfuscate(code) {
  let Obfuscator;
  try {
    Obfuscator = (await import('javascript-obfuscator')).default;
  } catch {
    log('javascript-obfuscator not installed — skipping (npm i -D javascript-obfuscator)');
    return code;
  }
  const out = Obfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.3,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.7,
    sourceType: 'module',
    reservedStrings: ['^\\./', '^node:'],
  });
  return out.getObfuscatedCode();
}

async function main() {
  await fsp.rm(DIST, { recursive: true, force: true });
  await fsp.mkdir(DIST, { recursive: true });
  const integrity = {};

  // ---- background-process worker ---------------------------------------
  // Built first so the app bundle can reference it by its content hash.
  log('bundling the background-process worker (node runtime in a Web Worker)');
  let worker = await bundle(path.join(ROOT, 'web', 'engine', 'worker.js'));
  const workerName = `worker.${sha(worker)}.js`;
  await fsp.writeFile(path.join(DIST, 'assets', workerName), worker);
  log(`assets/${workerName} (${(Buffer.byteLength(worker) / 1024).toFixed(0)} KB)`);

  // ---- JS + CSS --------------------------------------------------------
  log('bundling the client (harness + filesystem + shell + npm + sqlite + deploy)');
  let js = await bundle(undefined, { __WORKER_URL__: JSON.stringify(`/assets/${workerName}`) });
  if (OBFUSCATE) js = await obfuscate(js);
  const jsName = `app.${sha(js)}.js`;
  await fsp.writeFile(path.join(DIST, 'assets', jsName), js);
  integrity[jsName] = sri(Buffer.from(js));
  log(`assets/${jsName} (${(js.length / 1024).toFixed(0)} KB${OBFUSCATE ? ', obfuscated' : ''})`);

  const cssRaw = await fsp.readFile(path.join(ROOT, 'web', 'app.css'), 'utf8');
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,>+~])\s*/g, '$1').replace(/;}/g, '}').trim();
  const cssName = `app.${sha(css)}.css`;
  await fsp.writeFile(path.join(DIST, 'assets', cssName), css);
  integrity[cssName] = sri(Buffer.from(css));
  log(`assets/${cssName} (${(css.length / 1024).toFixed(1)} KB)`);

  // ---- html ------------------------------------------------------------
  let html = await fsp.readFile(path.join(ROOT, 'web', 'index.html'), 'utf8');
  html = html
    .replace('<link rel="stylesheet" href="/assets/app.css">', `<link rel="stylesheet" href="/assets/${cssName}" integrity="${integrity[cssName]}" crossorigin="anonymous">`)
    .replace('<script type="module" src="/assets/app.js"></script>', `<script type="module" src="/assets/${jsName}" integrity="${integrity[jsName]}" crossorigin="anonymous"></script>`);
  await fsp.writeFile(path.join(DIST, 'index.html'), html);
  for (const file of ['manifest.webmanifest', 'favicon.svg']) {
    const from = path.join(ROOT, 'public', file);
    if (fs.existsSync(from)) await fsp.copyFile(from, path.join(DIST, file));
  }

  // ---- optional: the full npm engine -----------------------------------
  // Vendored by `npm run vendor:nodepod`, never committed. Copied verbatim
  // because it resolves its own workers relative to its module URL, and loaded
  // lazily — a deployment without it just uses the built-in installer.
  const nodepodDir = path.join(ROOT, 'public', 'nodepod');
  if (fs.existsSync(path.join(nodepodDir, 'index.mjs'))) {
    const target = path.join(DIST, 'nodepod');
    await fsp.cp(nodepodDir, target, { recursive: true });
    const size = (await dirSize(target)) / 1024 / 1024;
    const manifest = JSON.parse(await fsp.readFile(path.join(nodepodDir, 'manifest.json'), 'utf8').catch(() => '{}'));
    log(`nodepod ${manifest.version || ''} (${size.toFixed(1)} MB) → /nodepod — full npm engine`);
  } else {
    log('nodepod not vendored — npm uses the built-in resolver (npm run vendor:nodepod to enable)');
  }

  // ---- fonts -----------------------------------------------------------
  // Self-hosted so the app never waits on a CDN and works offline. Three
  // woff2 files, latin subset: UI (Geist), code (Geist Mono) and the editorial
  // serif used for hero moments (Instrument Serif italic).
  const FONTS = [
    ['@fontsource-variable/geist', 'geist-latin-wght-normal.woff2', 'geist.woff2'],
    ['@fontsource-variable/geist-mono', 'geist-mono-latin-wght-normal.woff2', 'geist-mono.woff2'],
    ['@fontsource/instrument-serif', 'instrument-serif-latin-400-italic.woff2', 'instrument-serif-italic.woff2'],
  ];
  await fsp.mkdir(path.join(DIST, 'assets', 'fonts'), { recursive: true });
  for (const [pkg, file, name] of FONTS) {
    const from = path.join(ROOT, 'node_modules', pkg, 'files', file);
    if (!fs.existsSync(from)) {
      log(`warning: ${pkg} is not installed — the UI falls back to system fonts`);
      continue;
    }
    await fsp.copyFile(from, path.join(DIST, 'assets', 'fonts', name));
  }
  log(`assets/fonts/ (${FONTS.length} files, self-hosted)`);

  // ---- sqlite wasm -----------------------------------------------------
  const wasmCandidates = [
    path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm-browser.wasm'),
  ];
  const wasm = wasmCandidates.find((p) => fs.existsSync(p));
  if (wasm) {
    await fsp.copyFile(wasm, path.join(DIST, 'assets', 'sql-wasm.wasm'));
    log(`assets/sql-wasm.wasm (${(fs.statSync(wasm).size / 1024).toFixed(0)} KB)`);
  } else {
    log('warning: sql.js is not installed — the database panel will fall back to the CDN');
  }

  // ---- pages functions -------------------------------------------------
  // Cloudflare Pages reads `functions/` from the *repository root*, not from
  // the build output, so these are validated here rather than copied into
  // dist/ (a copy would be dead weight and would never be executed).
  const functionsSrc = path.join(ROOT, 'functions');
  if (fs.existsSync(functionsSrc)) {
    const check = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) check(file);
        else if (entry.name.endsWith('.js')) {
          execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
          functions += 1;
        }
      }
    };
    let functions = 0;
    try {
      check(functionsSrc);
    } catch (err) {
      throw new Error(`functions/ has a syntax error: ${err.stderr?.toString().trim() || err.message}`);
    }
    log(`functions/ validated (${functions} files, served by Pages from the repo root)`);
  }

  // ---- pages config ----------------------------------------------------
  await fsp.writeFile(
    path.join(DIST, '_headers'),
    `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  X-Frame-Options: SAMEORIGIN
  Strict-Transport-Security: max-age=31536000; includeSubDomains
# Cross-Origin-Opener-Policy is set by functions/_middleware.js, not here: it
# depends on whether this visitor turned on the WebContainers sandbox, and a
# static header would be sent alongside it and win.

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/assets/sql-wasm.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache
`,
  );
  await fsp.writeFile(
    path.join(DIST, '_redirects'),
    `# SPA routes: the app owns them (preview + claim links are hash routes)
/claim/*  /index.html  200
/p/*      /index.html  200
`,
  );

  await fsp.writeFile(
    path.join(DIST, 'integrity.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), obfuscated: OBFUSCATE, minified: MINIFY, assets: integrity }, null, 2),
  );

  // ---- self-check ------------------------------------------------------
  const assets = await fsp.readdir(path.join(DIST, 'assets'));
  const referenced = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  for (const ref of referenced) if (!assets.includes(ref)) throw new Error(`index.html references missing asset ${ref}`);
  if (!/integrity="sha384-/.test(html)) throw new Error('SRI hashes missing from index.html');

  const total = (await Promise.all(assets.map((a) => fsp.stat(path.join(DIST, 'assets', a)))))
    .reduce((s, st) => s + st.size, 0);
  log(`done → dist/ (${assets.length} assets, ${(total / 1024).toFixed(0)} KB) — static files + Pages Functions, no server`);
}

main().catch((err) => {
  console.error('[build:pages] failed:', err.message);
  process.exit(1);
});
