#!/usr/bin/env node
/**
 * Deploy AlphaCode itself to Cloudflare.
 *
 *   npm run deploy:cloudflare -- [flags]
 *
 *   --name=<worker>     Worker name (default: alphacode)
 *   --origin=<url>      ALPHACODE_ORIGIN — the https URL of the Node runtime
 *                       (Cloudflare Container / Fly / Railway / VPS) that runs
 *                       the agent harness, PTY and SQLite.
 *   --no-build          Reuse an existing dist/ (skips the build + tests)
 *   --no-obfuscate      Build without the obfuscation pass (debuggable)
 *   --dry-run           Produce the bundle + wrangler config, do not upload
 *   --online            Allow `npx wrangler@4` to be downloaded if absent
 *
 * Auth: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) — never hardcoded, read
 * from the environment or from `.env` (which is gitignored).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'cloudflare');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
const say = (msg) => process.stdout.write(`${msg}\n`);
const step = (msg) => say(`${c.cyan}▸${c.reset} ${msg}`);
const ok = (msg) => say(`${c.green}✓${c.reset} ${msg}`);
const warn = (msg) => say(`${c.yellow}!${c.reset} ${msg}`);
const die = (msg, code = 1) => {
  say(`${c.red}✗ ${msg}${c.reset}`);
  process.exit(code);
};

// --------------------------------------------------------------- .env load ---
function loadDotEnv() {
  for (const file of ['.env.local', '.env']) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || m[1].startsWith('#')) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}

function run(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, { stdio: opts.capture ? 'pipe' : 'inherit', cwd: ROOT, env: process.env, encoding: 'utf8' });
  if (res.error) throw new Error(`${cmd} failed to start: ${res.error.message}`);
  return res;
}

// ------------------------------------------------------------------ build ----
async function build() {
  if (flag('no-build')) {
    if (!fs.existsSync(path.join(DIST, 'public', 'index.html'))) die('dist/ is missing — run without --no-build.');
    warn('reusing existing dist/');
    return;
  }
  step('running the test suite');
  const test = run(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', 'tests/*.test.mjs'], { capture: true });
  if (test.status !== 0) {
    say(test.stdout?.split('\n').filter((l) => /^(not ok|# (pass|fail))/.test(l)).join('\n') || '');
    die('tests failed — refusing to deploy.');
  }
  ok(`tests: ${(test.stdout.match(/# pass (\d+)/) || [])[1] || '?'} passing`);

  step(`building client bundle${flag('no-obfuscate') ? '' : ' (obfuscated)'}`);
  const buildArgs = ['scripts/build.mjs'];
  if (!flag('no-obfuscate')) buildArgs.push('--obfuscate');
  const res = run(process.execPath, buildArgs, { capture: true });
  if (res.status !== 0) {
    say(res.stderr || res.stdout || '');
    die('build failed.');
  }
  ok('bundle built (hashed filenames + SRI)');
}

async function verifyBundle() {
  const html = await fsp.readFile(path.join(DIST, 'public', 'index.html'), 'utf8');
  const integrity = (html.match(/integrity="sha384-[A-Za-z0-9+/=]+"/g) || []).length;
  if (!integrity) die('index.html has no SRI hashes — refusing to publish an unverifiable bundle.');
  const hashes = (html.match(/assets\/[a-z]+\.[0-9a-f]{8}\.(js|css)/g) || []).length;
  if (!hashes) die('no hashed asset references in index.html.');
  ok(`${hashes} asset refs, ${integrity} subresource-integrity hashes`);

  const worker = path.join(ROOT, 'src', 'edge', 'worker.mjs');
  if (!fs.existsSync(worker)) die('src/edge/worker.mjs is missing.');
  return { integrity, hashes };
}

async function writeWranglerConfig({ name, origin }) {
  await fsp.mkdir(OUT, { recursive: true });
  const config = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name,
    main: path.join(ROOT, 'src', 'edge', 'worker.mjs'),
    compatibility_date: '2025-09-01',
    compatibility_flags: ['nodejs_compat'],
    assets: {
      directory: path.join(DIST, 'public'),
      binding: 'ASSETS',
      run_worker_first: true,
    },
    observability: { enabled: true },
    vars: {
      ALPHACODE_ORIGIN: origin,
      ALPHACODE_VERSION: JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8')).version,
    },
  };
  const file = path.join(OUT, 'wrangler.jsonc');
  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

function findWrangler() {
  const local = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(local)) return { cmd: local, argv: [] };
  const probe = spawnSync('wrangler', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return { cmd: 'wrangler', argv: [] };
  if (flag('online')) return { cmd: 'npx', argv: ['--yes', 'wrangler@4'] };
  return null;
}

async function main() {
  loadDotEnv();
  say(`\n${c.bold}AlphaCode → Cloudflare${c.reset} ${c.dim}(edge facade + static assets)${c.reset}\n`);

  const name = opt('name', process.env.ALPHACODE_WORKER_NAME || 'alphacode');
  const origin = opt('origin', process.env.ALPHACODE_ORIGIN || '').replace(/\/+$/, '');

  if (!origin) {
    warn('ALPHACODE_ORIGIN is empty. The edge will serve the UI but /api will answer 503.');
    warn('Point it at your Node runtime, e.g. --origin=https://alphacode-runtime.fly.dev');
  } else if (!/^https:\/\//.test(origin)) {
    die('ALPHACODE_ORIGIN must be an https:// URL (the Worker cannot reach plain http).');
  }

  await build();
  const stats = await verifyBundle();
  const configFile = await writeWranglerConfig({ name, origin });
  ok(`wrangler config → ${path.relative(ROOT, configFile)}`);

  if (flag('dry-run')) {
    say(`\n${c.bold}Dry run complete.${c.reset}`);
    say('  bundle : dist/public (served by Workers Static Assets)');
    say('  worker : src/edge/worker.mjs (proxies /api/* and /p/* to ALPHACODE_ORIGIN)');
    say(`  upload : ${c.dim}npx wrangler deploy --config ${path.relative(ROOT, configFile)}${c.reset}`);
    return;
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    say(`\n${c.bold}Bundle ready, nothing uploaded.${c.reset} Set a token and re-run:\n`);
    say(`  export CLOUDFLARE_API_TOKEN=…        ${c.dim}# Workers Scripts:Edit + Account:Read${c.reset}`);
    say(`  export CLOUDFLARE_ACCOUNT_ID=…`);
    say(`  npm run deploy:cloudflare -- --origin=https://your-runtime.example.com\n`);
    say(`${c.dim}The token can also live in the Cloudflare dashboard for the runtime, or in .env (gitignored).${c.reset}`);
    return;
  }

  const wrangler = findWrangler();
  if (!wrangler) {
    warn('wrangler is not installed.');
    say(`\n  npm i -D wrangler@4 && npm run deploy:cloudflare\n  ${c.dim}# or re-run with --online to let npx fetch it${c.reset}\n`);
    return;
  }

  step(`uploading ${stats.hashes} assets + worker as "${name}"`);
  const res = spawnSync(wrangler.cmd, [...wrangler.argv, 'deploy', '--config', configFile], {
    cwd: ROOT,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '' },
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (res.status !== 0) die('wrangler deploy failed — see the output above.');

  say(`\n${c.green}${c.bold}Deployed.${c.reset}`);
  say(`  URL: https://${name}.<your-subdomain>.workers.dev`);
  say(`  ${c.dim}Claim it in the Cloudflare dashboard, then add a custom domain.${c.reset}`);
  if (origin) say(`  Runtime: ${origin}`);
  else warn('remember to set ALPHACODE_ORIGIN before sharing the link.');
  say('');
}

main().catch((err) => die(err.stack || err.message));
