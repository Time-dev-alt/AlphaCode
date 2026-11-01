/**
 * Language runtimes: detection, pinning and "make latest work".
 *
 * AlphaCode never assumes the host toolchain is modern. It detects Node, npm,
 * Python, pip/uv, git and database clients, understands `.nvmrc` /
 * `.node-version` / `.python-version` / `package.json engines`, and can fetch
 * and pin current releases into a per-instance toolchain directory:
 *
 *   data/runtimes/node-v24.x.y/…     (official nodejs.org tarball)
 *   data/runtimes/npm/…              (npm@latest, self-contained prefix)
 *   data/runtimes/python/…           (python-build-standalone or uv-managed)
 *
 * Toolchain installs are opt-in (ALPHACODE_ALLOW_TOOLCHAIN_INSTALL=1) but the
 * UI shows exactly what is current vs. latest at all times.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config } from '../config.mjs';
import { log } from '../lib/log.mjs';
import { runCommand, which, userEnv } from './exec.mjs';

const RUNTIME_DIR = path.join(config.dataDir, 'runtimes');
const NODE_DIST = 'https://nodejs.org/dist';
const ALLOW_INSTALL = /^(1|true|yes|on)$/i.test(String(process.env.ALPHACODE_ALLOW_TOOLCHAIN_INSTALL || '0'));

let cache = { at: 0, data: null };

export async function versionOf(cmd, args = ['--version']) {
  try {
    const res = await runCommand(`${cmd} ${args.join(' ')}`, { timeoutMs: 15000 });
    return (res.output.match(/\d+\.\d+\.\d+[^\s]*/) || [])[0] || res.output.trim().split('\n')[0] || '';
  } catch {
    return '';
  }
}

function semverTuple(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  const A = semverTuple(a) || [0, 0, 0];
  const B = semverTuple(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

async function latestRemote() {
  const out = { node: '', npm: '', python: '' };
  try {
    const res = await fetch(`${NODE_DIST}/index.json`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const list = await res.json();
      const lts = list.find((r) => r.lts);
      out.node = lts?.version?.replace(/^v/, '') || list[0]?.version?.replace(/^v/, '') || '';
      out.npm = lts?.npm || '';
    }
  } catch {}
  if (!out.npm) {
    try {
      const res = await fetch('https://registry.npmjs.org/npm/latest', { signal: AbortSignal.timeout(6000) });
      if (res.ok) out.npm = (await res.json()).version || '';
    } catch {}
  }
  return out;
}

/** Detected capabilities (cached 5 min). */
export async function detect({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < 5 * 60_000) return cache.data;
  const [nodePath, pythonPath, gitPath, rgPath, sqlitePath, psqlPath, mysqlPath, uvPath, dockerPath] = await Promise.all([
    which('node'),
    which('python3'),
    which('git'),
    which('rg'),
    which('sqlite3'),
    which('psql'),
    which('mysql'),
    which('uv'),
    which('docker'),
  ]);
  const [npmV, pythonV, pipV, gitV] = await Promise.all([
    versionOf('npm'),
    versionOf(pythonPath || 'python3', ['-c', '"import sys;print(\'.\'.join(map(str,sys.version_info[:3])))"']),
    versionOf('pip3'),
    versionOf(gitPath || 'git'),
  ]);
  const pinnedNode = pinnedToolchain('node');
  const nodeVersion = pinnedNode ? pinnedNode.version : process.version.replace(/^v/, '');
  let latest = { node: '', npm: '', python: '' };
  try {
    latest = await latestRemote();
  } catch {}
  const data = {
    node: {
      version: nodeVersion,
      binary: pinnedNode ? pinnedNode.bin : process.execPath,
      pinned: Boolean(pinnedNode),
      latest: latest.node,
      upToDate: latest.node ? cmp(nodeVersion, latest.node) >= 0 : null,
      installable: ALLOW_INSTALL,
    },
    npm: {
      version: npmV,
      latest: latest.npm,
      upToDate: latest.npm ? cmp(npmV, latest.npm) >= 0 : null,
      installable: ALLOW_INSTALL,
    },
    python: {
      version: pythonV || (await versionOf('python3')),
      binary: pythonPath,
      latest: latest.python,
      upToDate: null,
      venv: true,
      uv: Boolean(uvPath),
    },
    tools: {
      git: gitV,
      ripgrep: Boolean(rgPath),
      sqlite3: Boolean(sqlitePath),
      psql: Boolean(psqlPath),
      mysql: Boolean(mysqlPath),
      uv: Boolean(uvPath),
      docker: Boolean(dockerPath),
      pty: process.platform !== 'win32',
    },
    platform: `${os.platform()}-${os.arch()}`,
    allowInstall: ALLOW_INSTALL,
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return data;
}

function pinnedToolchain(kind) {
  try {
    const dirs = fs.readdirSync(RUNTIME_DIR).filter((d) => d.startsWith(kind + '-v'));
    if (!dirs.length) return null;
    dirs.sort((a, b) => cmp(a.split('-v')[1], b.split('-v')[1]));
    const latest = dirs[dirs.length - 1];
    const version = latest.split('-v')[1];
    const bin = kind === 'node' ? path.join(RUNTIME_DIR, latest, 'bin', 'node') : path.join(RUNTIME_DIR, latest, 'bin', 'python3');
    if (!fs.existsSync(bin)) return null;
    return { dir: path.join(RUNTIME_DIR, latest), version, bin };
  } catch {
    return null;
  }
}

/** Read version pins from the project files. */
export async function readPins(projectDir) {
  const pins = {};
  const readFirst = async (files) => {
    for (const f of files) {
      try {
        const v = (await fsp.readFile(path.join(projectDir, f), 'utf8')).trim().split('\n')[0].trim();
        if (v) return v.replace(/^v/, '');
      } catch {}
    }
    return '';
  };
  pins.node = await readFirst(['.nvmrc', '.node-version']);
  pins.python = await readFirst(['.python-version', 'runtime.txt']);
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(projectDir, 'package.json'), 'utf8'));
    pins.packageManager = pkg.packageManager || '';
    if (!pins.node && pkg.engines?.node) pins.node = pkg.engines.node.replace(/[^\d.]/g, '');
    pins.scripts = pkg.scripts || {};
    pins.deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    pins.framework = detectFramework(pkg);
  } catch {}
  try {
    pins.hasRequirements = fs.existsSync(path.join(projectDir, 'requirements.txt'));
    pins.hasPyProject = fs.existsSync(path.join(projectDir, 'pyproject.toml'));
  } catch {}
  return pins;
}

export function detectFramework(pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const has = (n) => Boolean(deps[n]);
  if (has('next')) return 'next';
  if (has('nuxt') || has('nuxt3')) return 'nuxt';
  if (has('@sveltejs/kit')) return 'sveltekit';
  if (has('astro')) return 'astro';
  if (has('@angular/core')) return 'angular';
  if (has('vite')) return 'vite';
  if (has('react-scripts')) return 'cra';
  if (has('gatsby')) return 'gatsby';
  if (has('vue')) return 'vue';
  if (has('react')) return 'react';
  if (has('express') || has('fastify') || has('koa') || has('hono')) return 'node-service';
  if (pkg?.type === 'module' || pkg?.main) return 'node';
  return 'static';
}

/** Install a specific Node.js release from nodejs.org into data/runtimes. */
export async function installNode(version, onLog = () => {}) {
  if (!ALLOW_INSTALL) throw new Error('Toolchain installs are disabled (set ALPHACODE_ALLOW_TOOLCHAIN_INSTALL=1)');
  const v = String(version).replace(/^v/, '');
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win' : 'linux';
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const dirName = `node-v${v}-${platform}-${arch}`;
  const ext = platform === 'win' ? 'zip' : 'tar.gz';
  const url = `${NODE_DIST}/v${v}/${dirName}.${ext}`;
  const target = path.join(RUNTIME_DIR, `node-v${v}`);
  const tmp = path.join(config.dataDir, 'tmp', `${dirName}.${ext}`);
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  onLog(`downloading Node ${v} (${arch})…`);
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  onLog('extracting…');
  const extractTo = path.join(config.dataDir, 'tmp', `node-extract-${Date.now()}`);
  await fsp.mkdir(extractTo, { recursive: true });
  const res2 = await runCommand(`tar -xzf ${JSON.stringify(tmp)} -C ${JSON.stringify(extractTo)}`, { timeoutMs: 300000 });
  if (res2.code !== 0) throw new Error('Extraction failed: ' + res2.output.slice(0, 500));
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(path.join(extractTo, dirName), target);
  await fsp.rm(extractTo, { recursive: true, force: true });
  await fsp.rm(tmp, { force: true });
  cache.at = 0;
  onLog(`Node ${v} ready at ${path.relative(config.root, target)}`);
  return { version: v, dir: target, bin: path.join(target, 'bin', 'node') };
}

/** Install npm@latest into an isolated prefix and use it for installs. */
export async function installNpmLatest(onLog = () => {}) {
  if (!ALLOW_INSTALL) throw new Error('Toolchain installs are disabled');
  const prefix = path.join(RUNTIME_DIR, 'npm');
  await fsp.mkdir(prefix, { recursive: true });
  onLog('installing npm@latest…');
  const res = await runCommand(`npm install --prefix ${JSON.stringify(prefix)} npm@latest --no-audit --no-fund`, {
    timeoutMs: 300000,
    cwd: config.dataDir,
  });
  if (res.code !== 0) throw new Error('npm install failed: ' + res.output.slice(-800));
  cache.at = 0;
  const bin = path.join(prefix, 'node_modules', '.bin', 'npm');
  return { version: (await versionOf(bin)) || 'latest', bin };
}

/**
 * Prepare a project for running: install dependencies with the right package
 * manager, create a Python venv when needed. Streams human-readable progress.
 */
export async function prepareProject(projectDir, onLog = () => {}, { install = true } = {}) {
  const pins = await readPins(projectDir);
  const steps = [];
  const hasPkg = fs.existsSync(path.join(projectDir, 'package.json'));
  if (hasPkg) {
    let manager = 'npm';
    if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) manager = 'pnpm';
    else if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) manager = 'yarn';
    else if (fs.existsSync(path.join(projectDir, 'bun.lockb'))) manager = 'bun';
    const lock = fs.existsSync(path.join(projectDir, 'package-lock.json'));
    if (install) {
      onLog(`installing JavaScript dependencies with ${manager}${lock ? ' (lockfile found)' : ''}…`);
      const cmd = manager === 'npm' ? (lock ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund') : `${manager} install`;
      const res = await runCommand(cmd, { cwd: projectDir, timeoutMs: 600000, onData: (d) => onLog(d) });
      steps.push({ step: `install:${manager}`, code: res.code, ok: res.code === 0 });
      if (res.code !== 0) onLog(`dependency install exited ${res.code} (continuing)`);
    }
    steps.push({ step: 'framework', value: pins.framework || '' });
  }
  if (pins.hasRequirements || pins.hasPyProject) {
    if (install) {
      const venv = path.join(projectDir, '.venv');
      if (!fs.existsSync(venv)) {
        onLog('creating Python virtual environment…');
        const r = await runCommand(`python3 -m venv ${JSON.stringify(venv)}`, { cwd: projectDir, timeoutMs: 180000 });
        steps.push({ step: 'venv', code: r.code, ok: r.code === 0 });
      }
      const pip = `"${path.join(venv, 'bin', 'pip')}"`;
      const args = pins.hasRequirements
        ? `${pip} install -q -r requirements.txt`
        : `${pip} install -q -e . 2>/dev/null || ${pip} install -q .`;
      onLog('installing Python dependencies…');
      const r = await runCommand(`${args} 2>&1 | tail -40`, { cwd: projectDir, timeoutMs: 900000 });
      steps.push({ step: 'pip', code: r.code, ok: r.code === 0 });
    }
  }
  return { pins, steps };
}

/** Build a static/JS project for deployment. Returns {dir, kind, log}. */
export async function buildProject(projectDir, onLog = () => {}) {
  const pins = await readPins(projectDir);
  const hasPkg = fs.existsSync(path.join(projectDir, 'package.json'));
  const framework = pins.framework || (hasPkg ? 'node' : 'static');
  const logs = [];
  const logLine = (s) => {
    logs.push(String(s));
    onLog(s);
  };

  if (hasPkg && (pins.scripts?.build || ['next', 'nuxt', 'sveltekit', 'astro', 'vite', 'cra', 'gatsby', 'angular'].includes(framework))) {
    await prepareProject(projectDir, logLine, { install: !fs.existsSync(path.join(projectDir, 'node_modules')) });
    logLine(`building with ${framework}…`);
    const cmd = pins.scripts?.build ? 'npm run build' : 'npx --yes vite build';
    const res = await runCommand(cmd, { cwd: projectDir, timeoutMs: 900000, onData: (d) => logLine(d) });
    if (res.code !== 0) throw new Error(`Build failed (exit ${res.code}).\n${res.output.slice(-2000)}`);
  }

  const candidates = [
    { dir: 'dist', kind: 'static' },
    { dir: 'build', kind: 'static' },
    { dir: 'out', kind: 'static' },
    { dir: '.output/public', kind: 'static' },
    { dir: 'public', kind: 'static' },
    { dir: '.next', kind: 'next' },
  ];
  for (const c of candidates) {
    const full = path.join(projectDir, c.dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      const entries = fs.readdirSync(full);
      if (entries.length) return { dir: full, kind: c.kind, framework, logs };
    }
  }
  // SPA entry at the root?
  for (const f of ['index.html', 'index.htm']) {
    if (fs.existsSync(path.join(projectDir, f))) return { dir: projectDir, kind: 'static', framework, logs };
  }
  return { dir: projectDir, kind: 'source', framework, logs };
}

export async function installVersion(kind, version, onLog) {
  if (kind === 'node') return installNode(version, onLog);
  if (kind === 'npm') return installNpmLatest(onLog);
  if (kind === 'python') {
    onLog('installing Python via uv (recommended)…');
    const uv = await runCommand(`uv python install ${version || ''}`, { timeoutMs: 600000, onData: (d) => onLog(d) });
    if (uv.code !== 0) throw new Error('uv is not available; install uv (https://docs.astral.sh/uv/) or use the system Python');
    return { version: version || 'latest (uv)' };
  }
  throw new Error(`Unknown runtime: ${kind}`);
}

export { RUNTIME_DIR, ALLOW_INSTALL };
