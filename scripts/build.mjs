#!/usr/bin/env node
/**
 * Production build with defence-in-depth:
 *
 *   1. content-hashed asset names (immutable caching + cache-busting)
 *   2. CSS/JS minification (comment stripping via a real lexer, not regex)
 *   3. Subresource Integrity (sha384) on every script/style tag
 *   4. optional identifier + string-array obfuscation of the client bundle
 *   5. optional server obfuscation (kept opt-in so audits stay possible)
 *   6. integrity manifest shipped next to the build
 *
 *   node scripts/build.mjs            # minified + SRI
 *   node scripts/build.mjs --obfuscate # minified + SRI + obfuscated client
 *   node scripts/build.mjs --obfuscate --server
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const args = new Set(process.argv.slice(2));
const OBFUSCATE = args.has('--obfuscate');
const OBFUSCATE_SERVER = args.has('--server');

const log = (...a) => console.log('[build]', ...a);
const sha = (buf, enc = 'hex') => crypto.createHash('sha256').update(buf).digest(enc);
const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

/**
 * Strip comments from JavaScript without breaking strings, template literals,
 * regexes or division. Conservative: whitespace/newlines are preserved so ASI
 * semantics cannot change.
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        const ch = src[i];
        out += ch;
        if (ch === '\\') {
          out += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        i++;
      }
      prevSignificant = quote;
      continue;
    }
    if (c === '/' && (prevSignificant === '' || /[=(,:;[!&|?{};+\-*%^~<>]/.test(prevSignificant))) {
      // regex literal
      out += c;
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        out += ch;
        if (ch === '\\') {
          out += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          i++;
          break;
        } else if (ch === '\n') break;
        i++;
      }
      let flags = '';
      while (i < src.length && /[a-z]/.test(src[i])) flags += src[i++];
      out += flags;
      prevSignificant = '/';
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    out += c;
    i++;
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line, idx, arr) => line.trim() !== '' || (idx > 0 && arr[idx - 1].trim() !== ''))
    .join('\n');
}

export function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>+~])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

async function obfuscate(code, { heavy = true } = {}) {
  let JavaScriptObfuscator;
  try {
    JavaScriptObfuscator = (await import('javascript-obfuscator')).default;
  } catch {
    log('javascript-obfuscator is not installed — run `npm i -D javascript-obfuscator` for obfuscation');
    return null;
  }
  const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: heavy,
    controlFlowFlatteningThreshold: heavy ? 0.35 : 0,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    sourceType: 'module',
    reservedStrings: ['^\\./', '^node:'],
    renameGlobals: false,
    selfDefending: heavy,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: heavy ? ['base64'] : [],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,
    transformObjectKeys: heavy,
    unicodeEscapeSequence: false,
  });
  return result.getObfuscatedCode();
}

async function main() {
  await fsp.rm(DIST, { recursive: true, force: true });
  await fsp.mkdir(path.join(DIST, 'public', 'assets'), { recursive: true });

  const integrity = {};
  const assetMap = new Map();

  // ---- client assets -----------------------------------------------------
  // Modules are imported by other modules, so leaves (util, term) must be hashed
  // before their importers (app) and the specifiers rewritten to the hashed
  // names — otherwise `dist/` ships imports that 404.
  const assetsDir = path.join(ROOT, 'public', 'assets');
  const DEP_ORDER = ['util.js', 'term.js', 'app.js'];
  const assetFiles = (await fsp.readdir(assetsDir))
    .filter((f) => /\.(js|css)$/.test(f))
    .sort((a, b) => {
      const ia = DEP_ORDER.indexOf(a);
      const ib = DEP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  /** Rewrite `./x.js` module specifiers to their hashed build names. */
  function rewriteImports(code) {
    let out = code;
    for (const [original, hashed] of assetMap) {
      if (!original.endsWith('.js')) continue;
      const rel = `./${original}`;
      out = out.split(`'${rel}'`).join(`'./${hashed}'`).split(`"${rel}"`).join(`"./${hashed}"`);
    }
    return out;
  }

  for (const file of assetFiles) {
    const full = path.join(assetsDir, file);
    const raw = await fsp.readFile(full);
    let code = raw.toString('utf8');
    if (file.endsWith('.css')) code = minifyCss(code);
    else {
      code = stripJsComments(code);
      if (OBFUSCATE) {
        const obf = await obfuscate(code, { heavy: true });
        if (obf) code = obf;
      }
      code = rewriteImports(code);
    }
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const hashed = `${base}.${sha(code).slice(0, 8)}${ext}`;
    await fsp.writeFile(path.join(DIST, 'public', 'assets', hashed), code);
    assetMap.set(file, hashed);
    integrity[hashed] = sri(Buffer.from(code));
    log(`asset ${file} → ${hashed} (${(code.length / 1024).toFixed(1)} KB)`);
  }

  // Every module import must point at a file that actually exists in dist/.
  for (const file of assetFiles.filter((f) => f.endsWith('.js'))) {
    const built = await fsp.readFile(path.join(DIST, 'public', 'assets', assetMap.get(file)), 'utf8');
    for (const m of built.matchAll(/from\s*["'](\.\/[^"']+)["']/g)) {
      const target = m[1].replace(/^\.\//, '');
      if (!fs.existsSync(path.join(DIST, 'public', 'assets', target))) {
        throw new Error(`${file} imports ./${target}, which is not in the build output`);
      }
    }
  }
  log('module graph verified (no dangling import specifiers)');

  // ---- html/manifest/favicon --------------------------------------------
  let html = await fsp.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const [original, hashed] of assetMap) {
    const href = `/assets/${original}`;
    const integ = integrity[hashed];
    if (original.endsWith('.css')) {
      html = html.replace(`<link rel="stylesheet" href="${href}">`, `<link rel="stylesheet" href="/assets/${hashed}" integrity="${integ}" crossorigin="anonymous">`);
    } else {
      html = html.replace(`<script type="module" src="${href}"></script>`, `<script type="module" src="/assets/${hashed}" integrity="${integ}" crossorigin="anonymous"></script>`);
    }
  }
  // Module-integrity import map: statically imported ES modules are verified
  // too, not just the entry script tag.
  const moduleIntegrity = {};
  for (const [original, hashed] of assetMap) {
    if (!original.endsWith('.js')) continue;
    moduleIntegrity[`/assets/${hashed}`] = integrity[hashed];
  }
  html = html.replace(
    '<script type="module"',
    `<script type="importmap">${JSON.stringify({ integrity: moduleIntegrity })}</script>\n<script type="module"`,
  );
  await fsp.writeFile(path.join(DIST, 'public', 'index.html'), html);
  for (const file of ['claim.html', 'manifest.webmanifest', 'favicon.svg']) {
    await fsp.copyFile(path.join(ROOT, 'public', file), path.join(DIST, 'public', file));
  }

  // ---- server bundle -----------------------------------------------------
  const copyTree = async (from, to) => {
    await fsp.mkdir(to, { recursive: true });
    for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) await copyTree(src, dest);
      else if (entry.name.endsWith('.mjs')) {
        const code = await fsp.readFile(src, 'utf8');
        await fsp.writeFile(dest, stripJsComments(code));
      } else await fsp.copyFile(src, dest);
    }
  };
  await copyTree(path.join(ROOT, 'src'), path.join(DIST, 'src'));
  if (OBFUSCATE_SERVER && OBFUSCATE) {
    for (const file of await fsp.readdir(path.join(DIST, 'src'), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.mjs')) continue;
      const full = path.join(DIST, 'src', file.name);
      const obf = await obfuscate(await fsp.readFile(full, 'utf8'), { heavy: false });
      if (obf) await fsp.writeFile(full, obf);
    }
    log('server sources obfuscated (moderate preset)');
  }
  await fsp.mkdir(path.join(DIST, 'native'), { recursive: true });
  await fsp.copyFile(path.join(ROOT, 'native', 'ptyhelper.c'), path.join(DIST, 'native', 'ptyhelper.c'));

  await fsp.writeFile(
    path.join(DIST, 'start.mjs'),
    `#!/usr/bin/env node
// AlphaCode production entrypoint.
// Serves the hashed, integrity-checked client bundle from ./public.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.ALPHACODE_PUBLIC_DIR ||= path.join(here, 'public');
process.env.NODE_ENV ||= 'production';
await import('./src/server.mjs');
`,
  );

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const distPkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: 'module',
    scripts: { start: 'node --disable-warning=ExperimentalWarning start.mjs' },
    engines: pkg.engines,
  };
  await fsp.writeFile(path.join(DIST, 'package.json'), JSON.stringify(distPkg, null, 2));
  await fsp.writeFile(path.join(DIST, 'integrity.json'), JSON.stringify({ generatedAt: new Date().toISOString(), obfuscated: OBFUSCATE, assets: integrity }, null, 2));

  log(`done → dist/ (${OBFUSCATE ? 'obfuscated' : 'minified'} client, integrity manifest written)`);
  log('run: cd dist && node start.mjs');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[build] failed:', err);
    process.exit(1);
  });
}
